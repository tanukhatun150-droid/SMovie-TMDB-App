/**
 * EmbedPlayer — v3.0 Netflix-style WebView player
 *
 * Improvements over v2:
 *   • Aggressive ad/overlay blocking: eliminates popups, full-screen ads,
 *     redirect navigations, cookie banners, and overlay divs via CSS + JS.
 *   • Video plays as-is inside the WebView — looks clean and Netflix-like
 *     because all third-party chrome/ads are stripped.
 *   • User-facing server picker with a Hindi-first VidSrc embed.
 */

import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Platform,
  ScrollView,
} from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { Feather } from "@expo/vector-icons";
import { BlurView } from "expo-blur";

// ─── Source definitions ────────────────────────────────────────────────────────

export interface EmbedSource {
  name: string;
  subtitle: string;
  urlMovie: (tmdbId: number) => string;
  urlTV: (tmdbId: number, season: number, episode: number) => string;
}

// Keep the user-facing list short and intentional. The first source is the
// requested Hindi embed; the remaining servers are practical fallbacks.
export const EMBED_SOURCES: EmbedSource[] = [
  {
    name: "VidSrc Hindi",
    subtitle: "Hindi Embed",
    urlMovie: (id) => `https://vidsrc.to/embed/movie/${id}?ds_lang=hi`,
    urlTV: (id, s, e) => `https://vidsrc.to/embed/tv/${id}/${s}/${e}?ds_lang=hi`,
  },
  {
    name: "VidSrc",
    subtitle: "Default Embed",
    urlMovie: (id) => `https://vidsrc.to/embed/movie/${id}`,
    urlTV: (id, s, e) => `https://vidsrc.to/embed/tv/${id}/${s}/${e}`,
  },
  {
    name: "VidSrc.me",
    subtitle: "Backup Embed",
    urlMovie: (id) => `https://vidsrc.me/embed/movie?tmdb=${id}`,
    urlTV: (id, s, e) => `https://vidsrc.me/embed/tv?tmdb=${id}&season=${s}&episode=${e}`,
  },
  {
    name: "MultiEmbed",
    subtitle: "Backup Server",
    urlMovie: (id) => `https://multiembed.mov/directstream.php?video_id=${id}&tmdb=1`,
    urlTV: (id, s, e) => `https://multiembed.mov/directstream.php?video_id=${id}&tmdb=1&s=${s}&e=${e}`,
  },
];

// ─── Timing constants ──────────────────────────────────────────────────────────

const NEXT_EP_COUNTDOWN = 5;    // seconds before auto-playing next episode

// ─── Ad-blocking JS — injected BEFORE page content loads ──────────────────────
// Runs in the WebView's isolated JS context. Blocks popup windows, disables
// webdriver fingerprinting, and intercepts redirect attempts.
const INJECT_BEFORE = `
(function() {
  try {
    // Anti-fingerprinting
    Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'hi'] });
  } catch(e) {}

  // Block popup windows entirely
  window.open = function() { return null; };
  window.alert = function() {};
  window.confirm = function() { return false; };
  window.prompt = function() { return null; };

  // Block redirect navigation attempts (common in ad scripts)
  var _pushState = history.pushState.bind(history);
  var _replaceState = history.replaceState.bind(history);
  Object.defineProperty(window, 'location', {
    get: function() { return window._safeLocation || location; },
    configurable: true,
  });

  // Block common ad SDK loaders
  var AD_DOMAINS = [
    'doubleclick', 'googlesyndication', 'adservice', 'popads', 'popcash',
    'exoclick', 'trafficjunky', 'adnxs', 'adsystem', 'adform',
    'pubmatic', 'rubiconproject', 'openx', 'criteo', 'taboola',
    'outbrain', 'media.net', 'valueimpression', 'mgid',
  ];
  var _fetch = window.fetch;
  window.fetch = function(url) {
    var s = String(url || '');
    for (var i = 0; i < AD_DOMAINS.length; i++) {
      if (s.indexOf(AD_DOMAINS[i]) !== -1) return Promise.reject(new Error('blocked'));
    }
    return _fetch.apply(this, arguments);
  };
  var _XHR = window.XMLHttpRequest;
  var _XHROpen = _XHR.prototype.open;
  _XHR.prototype.open = function(m, url) {
    var s = String(url || '');
    for (var i = 0; i < AD_DOMAINS.length; i++) {
      if (s.indexOf(AD_DOMAINS[i]) !== -1) { this._blocked = true; return; }
    }
    return _XHROpen.apply(this, arguments);
  };
  var _XHRSend = _XHR.prototype.send;
  _XHR.prototype.send = function() { if (this._blocked) return; return _XHRSend.apply(this, arguments); };

  true;
})();
`;

// ─── Ad-blocking CSS + event listeners — injected AFTER page loads ────────────
// Hides overlay/popup divs, prevents navigation hijacking, detects video events.
const INJECT_AFTER = `
(function(){
  // ── CSS: nuke overlays, popups, banners, cookie notices ─────────────────────
  var adCss = [
    '#popup', '#overlay', '#ad-overlay', '#advertisement',
    '.popup', '.popup-overlay', '.ad-overlay', '.ads-overlay',
    '.modal-backdrop', '#gdpr-overlay', '.cookie-consent', '.cookie-banner',
    '[class*="popup"]', '[id*="popup"]',
    '[class*="overlay"]:not(video)', '[id*="overlay"]:not(video)',
    '[class*="ad-"]', '[id*="ad-"]',
    '[class*="banner"]', '[id*="banner"]',
    'iframe[src*="ads"]', 'iframe[src*="doubleclick"]',
    'iframe[src*="googlesyndication"]', 'iframe[src*="adservice"]',
    '[id*="advert"]', '[class*="advert"]',
    '.interstitial', '#interstitial', '.overlay-container',
    '.vjs-text-track-display .vjs-modal-dialog',
    '.plyr__ads', '.ima-ad-container',
    // Common Cloudflare / anti-bot overlays
    '#challenge-running', '#challenge-form',
  ].join(',') + '{display:none!important;visibility:hidden!important;opacity:0!important;pointer-events:none!important;}';

  var style = document.createElement('style');
  style.id = '__smovie_blocker';
  style.textContent = adCss;
  (document.head || document.documentElement).appendChild(style);

  // ── Block script-created popups ───────────────────────────────────────────
  window.open = function() { return null; };
  window.alert = function() {};
  window.confirm = function() { return false; };

  // ── Block only true popup/new-tab link clicks ─────────────────────────────
  // Do NOT block external href navigations — many embed players use <a href>
  // to navigate to their video CDN or internal player pages. Blocking these
  // was preventing the Play button from working on SmashyStream, SuperEmbed, etc.
  document.addEventListener('click', function(e) {
    var el = e.target;
    while (el && el.tagName !== 'A') el = el.parentElement;
    if (!el) return;
    var target = el.getAttribute('target') || '';
    var href = el.getAttribute('href') || '';
    // Only block _blank (new tab) attempts and ad domain links
    var AD_HOSTS = ['doubleclick', 'googlesyndication', 'adservice', 'popads', 'exoclick'];
    var isAd = AD_HOSTS.some(function(d) { return href.indexOf(d) !== -1; });
    if (target === '_blank' || isAd) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // ── Video event forwarding to React Native ────────────────────────────────
  function onVideoEvent(eventName) {
    return function() {
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(eventName);
    };
  }

  var attachedVideos = new WeakSet();

  function attachToVideo(video) {
    if (attachedVideos.has(video)) return;
    attachedVideos.add(video);

    // Remove controls from video element so we own the UI layer
    video.removeAttribute('controls');

    video.addEventListener('playing',  onVideoEvent('video_playing'));
    video.addEventListener('canplay',  onVideoEvent('video_canplay'));
    video.addEventListener('ended',    onVideoEvent('video_ended'));
    video.addEventListener('error',    onVideoEvent('video_error'));
    video.addEventListener('waiting',  onVideoEvent('video_buffering'));
    video.addEventListener('timeupdate', function() {
      if (video.duration > 0 && window.ReactNativeWebView) {
        var now = Date.now();
        if (!video.__smovieLastProgress || now - video.__smovieLastProgress >= 5000) {
          video.__smovieLastProgress = now;
          window.ReactNativeWebView.postMessage('video_progress:' + JSON.stringify({
            positionSec: video.currentTime,
            durationSec: video.duration
          }));
        }
      }
      if (video.duration > 0 && video.currentTime / video.duration > 0.95) {
        window.ReactNativeWebView && window.ReactNativeWebView.postMessage('video_near_end');
      }
    });

    // Auto-unmute if muted by default (common on embed sites)
    if (video.muted) {
      video.muted = false;
      video.volume = 1;
    }
  }

  // Attach to videos already in the DOM
  document.querySelectorAll('video').forEach(attachToVideo);

  // Watch for dynamically added videos and new overlay divs
  var mo = new MutationObserver(function(mutations) {
    mutations.forEach(function(m) {
      m.addedNodes.forEach(function(node) {
        if (node.nodeType !== 1) return;
        if (node.tagName === 'VIDEO') attachToVideo(node);
        var vids = node.querySelectorAll && node.querySelectorAll('video');
        if (vids) vids.forEach(attachToVideo);
        // Hide dynamically-inserted ad overlays
        var isDomAd = (node.id || node.className || '').match(/popup|overlay|ad[-_]|banner|interstitial/i);
        if (isDomAd) {
          node.style.cssText += ';display:none!important;visibility:hidden!important;';
        }
      });
    });
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // ── Block iframe-in-iframe redirect attacks ───────────────────────────────
  document.querySelectorAll('iframe').forEach(function(f) {
    var src = f.src || '';
    var AD_PATS = ['doubleclick', 'googlesyndication', 'adservice', 'popads', 'exoclick', 'trafficjunky'];
    for (var i = 0; i < AD_PATS.length; i++) {
      if (src.indexOf(AD_PATS[i]) !== -1) { f.remove(); return; }
    }
  });

  true;
})();
`;

// ─── Props ────────────────────────────────────────────────────────────────────

interface EmbedPlayerProps {
  tmdbId:       number;
  mediaType:    "movie" | "tv";
  season?:      number;
  episode?:     number;
  title?:       string;
  nextEpisode?: { season: number; episode: number } | null;
  onBack?:      () => void;
  onNextEpisode?: () => void;
  onProgress?: (positionSec: number, durationSec: number) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function EmbedPlayer({
  tmdbId,
  mediaType,
  season  = 1,
  episode = 1,
  title,
  nextEpisode,
  onBack,
  onNextEpisode,
  onProgress,
}: EmbedPlayerProps) {
  // Source ordering — starts with the Hindi server and changes only by user choice.
  const [sourceOrder, setSourceOrder] = useState<number[]>(
    EMBED_SOURCES.map((_, i) => i),
  );
  const [orderIdx, setOrderIdx]   = useState(0); // index into sourceOrder
  const [loading, setLoading]     = useState(true);
  const [videoStarted, setVideoStarted] = useState(false);
  const [nextEpCountdown, setNextEpCountdown] = useState<number | null>(null);
  const [showServerPicker, setShowServerPicker] = useState(false);

  const webViewRef         = useRef<WebView>(null);
  const countdownInterval  = useRef<ReturnType<typeof setInterval> | null>(null);
  const nearEndFired        = useRef(false);
  const videoStartedRef    = useRef(false);

  // Keep ref in sync for use inside closures
  useEffect(() => { videoStartedRef.current = videoStarted; }, [videoStarted]);

  const currentSourceIdx = sourceOrder[orderIdx] ?? 0;
  const currentSource    = EMBED_SOURCES[currentSourceIdx];
  const embedUrl =
    mediaType === "movie"
      ? currentSource.urlMovie(tmdbId)
      : currentSource.urlTV(tmdbId, season, episode);

  // Reset to the Hindi-first source whenever the title or episode changes.
  useEffect(() => {
    setSourceOrder(EMBED_SOURCES.map((_, index) => index));
    setOrderIdx(0);
  }, [tmdbId, mediaType, season, episode]);

  // Reset on source change
  useEffect(() => {
    setLoading(true);
    setVideoStarted(false);
    videoStartedRef.current = false;
    nearEndFired.current = false;
  }, [orderIdx, tmdbId, season, episode]);


  // ── Next-episode countdown ────────────────────────────────────────────────
  const startNextEpCountdown = useCallback(() => {
    if (!nextEpisode || !onNextEpisode) return;
    setNextEpCountdown(NEXT_EP_COUNTDOWN);
    countdownInterval.current = setInterval(() => {
      setNextEpCountdown((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(countdownInterval.current!);
          onNextEpisode();
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  }, [nextEpisode, onNextEpisode]);

  useEffect(() => {
    return () => { if (countdownInterval.current) clearInterval(countdownInterval.current); };
  }, []);

  // ── WebView message handler ───────────────────────────────────────────────
  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const msg = event.nativeEvent.data;
      if (msg === "video_playing" || msg === "video_canplay") {
        setVideoStarted(true);
        videoStartedRef.current = true;
        setLoading(false);
      }
      if (msg.startsWith("video_progress:")) {
        try {
          const progress = JSON.parse(msg.slice("video_progress:".length)) as {
            positionSec?: number;
            durationSec?: number;
          };
          if (
            typeof progress.positionSec === "number" &&
            typeof progress.durationSec === "number" &&
            progress.positionSec > 0
          ) {
            onProgress?.(progress.positionSec, progress.durationSec);
          }
        } catch {
          // Ignore malformed messages from third-party embeds.
        }
      }
      if (msg === "video_ended") startNextEpCountdown();
      if (msg === "video_near_end" && !nearEndFired.current && mediaType === "tv") {
        nearEndFired.current = true;
        startNextEpCountdown();
      }
      if (msg === "video_error") setLoading(false);
    },
    [onProgress, startNextEpCountdown, mediaType],
  );

  const handleLoadStart = useCallback(() => { setLoading(true); }, []);

  const handleLoadEnd = useCallback(() => {
    setLoading(false);
    webViewRef.current?.injectJavaScript(INJECT_AFTER);
  }, []);

  const handleError = useCallback(() => {
    setLoading(false);
  }, []);

  const cancelNextEp = useCallback(() => {
    if (countdownInterval.current) clearInterval(countdownInterval.current);
    setNextEpCountdown(null);
  }, []);

  const selectServer = useCallback((index: number) => {
    setSourceOrder((previous) => [index, ...previous.filter((item) => item !== index)]);
    setOrderIdx(0);
    setShowServerPicker(false);
    setLoading(true);
    setVideoStarted(false);
    videoStartedRef.current = false;
  }, []);

  const serverPicker = (
    <View style={styles.serverPicker}>
      <View style={styles.serverPickerHeader}>
        <Text style={styles.serverPickerTitle}>Choose server</Text>
        <Text style={styles.serverPickerStatus}>
          Ready
        </Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.serverList}
      >
        {EMBED_SOURCES.map((source, index) => {
          const active = currentSourceIdx === index;
          return (
            <Pressable
              key={source.name}
              onPress={() => selectServer(index)}
              style={({ pressed }) => [
                styles.serverChip,
                active && styles.serverChipActive,
                pressed && { opacity: 0.72 },
              ]}
            >
              <Feather
                name={source.name === "VidSrc Hindi" ? "globe" : "server"}
                size={14}
                color={active ? "#fff" : "#c4c4c4"}
              />
              <View>
                <Text style={[styles.serverChipText, active && styles.serverChipTextActive]}>
                  {source.name}
                </Text>
                <Text style={styles.serverChipSubtitle}>{source.subtitle}</Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );

  // ── Render ────────────────────────────────────────────────────────────────

  // ── Web platform: use native <iframe> — WebView is not supported on web ───
  if (Platform.OS === "web") {
    return (
      <View style={styles.container}>
        {React.createElement("iframe", {
          key: `embed-web-${currentSourceIdx}-${tmdbId}-${season}-${episode}`,
          src: embedUrl,
          style: {
            position: "absolute" as const,
            top: 0, left: 0,
            width: "100%", height: "100%",
            border: "none",
            backgroundColor: "#000",
          },
          allowFullScreen: true,
          allow: "autoplay; fullscreen; encrypted-media; picture-in-picture",
          referrerPolicy: "no-referrer",
        })}

        {/* Top bar: back + title */}
        <View style={styles.topBar} pointerEvents="box-none">
          <Pressable
            style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.7 }]}
            onPress={onBack}
          >
            <BlurView intensity={60} tint="dark" style={styles.iconBtnBlur}>
              <Feather name="arrow-left" size={20} color="#fff" />
            </BlurView>
          </Pressable>
          {title ? (
            <Text style={styles.titleText} numberOfLines={1}>
              {title}
              {mediaType === "tv" ? `  S${season}:E${episode}` : ""}
            </Text>
          ) : null}
          <Pressable
            onPress={() => setShowServerPicker((visible) => !visible)}
            style={({ pressed }) => [styles.serverButton, pressed && { opacity: 0.7 }]}
            accessibilityRole="button"
            accessibilityLabel="Choose streaming server"
          >
            <Feather name="server" size={15} color="#fff" />
            <Text style={styles.serverButtonText}>Servers</Text>
          </Pressable>
        </View>
        {showServerPicker && serverPicker}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* WebView — native only */}
      <WebView
        ref={webViewRef}
        key={`embed-${currentSourceIdx}-${tmdbId}-${season}-${episode}`}
        source={{ uri: embedUrl }}
        style={StyleSheet.absoluteFill}
        allowsInlineMediaPlayback
        allowsFullscreenVideo
        mediaPlaybackRequiresUserAction={false}
        javaScriptEnabled
        domStorageEnabled
        allowsProtectedMedia
        mixedContentMode="always"
        originWhitelist={["*"]}
        injectedJavaScriptBeforeContentLoaded={INJECT_BEFORE}
        userAgent="Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.122 Mobile Safari/537.36"
        onLoadStart={handleLoadStart}
        onLoadEnd={handleLoadEnd}
        onError={handleError}
        onHttpError={handleError}
        onMessage={handleMessage}
        setSupportMultipleWindows={false}
        onShouldStartLoadWithRequest={(req) => {
          const url = req.url ?? "";
          const blocked = [
            "doubleclick", "googlesyndication", "adservice", "popads",
            "popcash", "exoclick", "trafficjunky", "adnxs", "taboola",
            "outbrain", "media.net", "mgid", "valueimpression", "pubmatic",
            "adform", "rubiconproject", "openx", "criteo",
          ];
          if (blocked.some((d) => url.includes(d))) return false;
          return true;
        }}
      />

      {/* Loading Spinner — small, no branding */}
      {loading && !videoStarted && (
        <View style={styles.loadingOverlay} pointerEvents="none">
          <ActivityIndicator size="large" color="#E50914" />
        </View>
      )}

      {/* Top bar: back + title + live server indicator */}
      <View style={styles.topBar} pointerEvents="box-none">
        <Pressable
          style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.7 }]}
          onPress={onBack}
        >
          <BlurView intensity={60} tint="dark" style={styles.iconBtnBlur}>
            <Feather name="arrow-left" size={20} color="#fff" />
          </BlurView>
        </Pressable>

        {title ? (
          <Text style={styles.titleText} numberOfLines={1}>
            {title}
            {mediaType === "tv" ? `  S${season}:E${episode}` : ""}
          </Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        <Pressable
          onPress={() => setShowServerPicker((visible) => !visible)}
          style={({ pressed }) => [styles.serverButton, pressed && { opacity: 0.7 }]}
          accessibilityRole="button"
          accessibilityLabel="Choose streaming server"
        >
          <Feather name="server" size={15} color="#fff" />
          <Text style={styles.serverButtonText}>Servers</Text>
        </Pressable>
      </View>
      {showServerPicker && serverPicker}

      {/* Next Episode Countdown Banner */}
      {nextEpCountdown !== null && nextEpisode && (
        <View style={styles.nextEpBanner}>
          <BlurView intensity={80} tint="dark" style={styles.nextEpInner}>
            <View style={{ flex: 1 }}>
              <Text style={styles.nextEpLabel}>Next Episode</Text>
              <Text style={styles.nextEpInfo}>
                S{nextEpisode.season} · E{nextEpisode.episode} · playing in {nextEpCountdown}s
              </Text>
            </View>
            <Pressable style={styles.nextEpPlayBtn} onPress={onNextEpisode}>
              <Feather name="skip-forward" size={18} color="#fff" />
            </Pressable>
            <Pressable style={styles.nextEpCancelBtn} onPress={cancelNextEp}>
              <Text style={styles.nextEpCancelText}>Cancel</Text>
            </Pressable>
          </BlurView>
        </View>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.75)",
    justifyContent: "center",
    alignItems: "center",
  },
  topBar: {
    position: "absolute",
    top: Platform.OS === "ios" ? 50 : 30,
    left: 16,
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    zIndex: 100,
  },
  iconBtn: {
    borderRadius: 24,
    overflow: "hidden",
  },
  iconBtnBlur: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
  },
  titleText: {
    flex: 1,
    color: "#fff",
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    textShadowColor: "rgba(0,0,0,0.9)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  serverButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderRadius: 18,
    backgroundColor: "rgba(20,20,20,0.82)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
  },
  serverButtonText: {
    color: "#fff",
    fontSize: 12,
    fontFamily: "Inter_700Bold",
  },
  serverPicker: {
    position: "absolute",
    top: 82,
    left: 16,
    right: 16,
    zIndex: 120,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: "rgba(13,13,13,0.96)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.16)",
  },
  serverPickerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    marginBottom: 10,
  },
  serverPickerTitle: {
    color: "#fff",
    fontSize: 13,
    fontFamily: "Inter_700Bold",
  },
  serverPickerStatus: {
    color: "#8d8d8d",
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
  serverList: {
    gap: 8,
  },
  serverChip: {
    minWidth: 126,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.07)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  serverChipActive: {
    backgroundColor: "rgba(229,9,20,0.28)",
    borderColor: "#e50914",
  },
  serverChipText: {
    color: "#c4c4c4",
    fontSize: 12,
    fontFamily: "Inter_700Bold",
  },
  serverChipTextActive: {
    color: "#fff",
  },
  serverChipSubtitle: {
    color: "#7b7b7b",
    fontSize: 10,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  nextEpBanner: {
    position: "absolute",
    bottom: 40,
    right: 16,
    left: 16,
    borderRadius: 16,
    overflow: "hidden",
    zIndex: 200,
  },
  nextEpInner: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    gap: 12,
  },
  nextEpLabel: {
    color: "#E50914",
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  nextEpInfo: {
    color: "#fff",
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    marginTop: 2,
  },
  nextEpPlayBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#E50914",
    justifyContent: "center",
    alignItems: "center",
  },
  nextEpCancelBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  nextEpCancelText: {
    color: "#888",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
});
