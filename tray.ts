// Use require() for systray2 - works better with Bun compile
const SysTray = require("systray2").default;
import type { ClickEvent } from "systray2";
import { Client } from "@xhayper/discord-rpc";
import { ActivityType } from "discord-api-types/v10";
import { $ } from "bun";

// Discord Application Client ID
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "YOUR_CLIENT_ID_HERE";

// Telegram bundle identifiers (macOS)
const TELEGRAM_BUNDLE_IDS = [
  "ru.keepcoder.Telegram",
  "org.telegram.desktop",
  "com.tdesktop.Telegram",
];

// Polling interval in milliseconds
const POLL_INTERVAL = 5000;

// Artwork cache
const artworkCache = new Map<string, string | null>();

// Track state
let currentTrackId: string | null = null;
let currentTrackStartTime: number | null = null;
let lastTrack: string | null = null;
let isPaused = false;
let isConnected = false;

// Music note icon (44x44 PNG @ 144 DPI for Retina menu bar, template style - WHITE on transparent)
// Larger icon that fills ~90% of the menu bar height to match system icons like headphones
// With isTemplateIcon: true, macOS will auto-tint for light/dark mode
const ICON_PLAYING = "iVBORw0KGgoAAAANSUhEUgAAACwAAAAsCAYAAAAehFoBAAAAAXNSR0IArs4c6QAAAHhlWElmTU0AKgAAAAgABAEaAAUAAAABAAAAPgEbAAUAAAABAAAARgEoAAMAAAABAAIAAIdpAAQAAAABAAAATgAAAAAAAACQAAAAAQAAAJAAAAABAAOgAQADAAAAAQABAACgAgAEAAAAAQAAACygAwAEAAAAAQAAACwAAAAALuNfAgAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAASVJREFUWAnt1uEKgzAMBGAde/9X3jwkEEosF63mCvbHWrXq1zODLsvb3gTmTmC9g//bWvTcdWvR+cy5T2by1blHC8k89/KKo5cxsLNpP5qwXxyzKD/fxmUJGwB9Ju2yhD04k7YEGHgWLVESPm2MeyUik7BH99KWTNjj27QlE/bgNm15sMdjLA+eriSmS7gU3H7eFtMeR/Mfr2Eg0Foce/w42GA7Ow8vA3u4jZm+HAxklPZR2UiALdkIbteslwIb6ihdXJcEGzzqpwN/o1Uw59pdFHPPiDlpcBXUFpsqiWos0DRYAUuDVbAUWAlLgTFJqdE1rIJ+wXd/CWrnP+KP19vQZBZJgfHAK+hRWDho8Fn0SGwanEWPxp4C4ya0XoncAd3fOuHvH08dWFF9sJxuAAAAAElFTkSuQmCC";

const ICON_PAUSED = ICON_PLAYING;

interface iTunesSearchResult {
  resultCount: number;
  results: Array<{
    artworkUrl100?: string;
    artworkUrl60?: string;
    artworkUrl30?: string;
    trackName?: string;
    artistName?: string;
    collectionName?: string;
  }>;
}

interface NowPlayingInfo {
  title: string | null;
  artist: string | null;
  album: string | null;
  duration: number | null;
  elapsedTime: number | null;
  timestamp: number | null;
  playbackRate: number | null;
  bundleIdentifier: string | null;
  isPlaying: boolean;
}

interface JXAResult {
  isPlaying: boolean;
  client: {
    bundleIdentifier: string | null;
    parentApplicationBundleIdentifier: string | null;
  } | null;
  info: {
    kMRMediaRemoteNowPlayingInfoTitle?: string;
    kMRMediaRemoteNowPlayingInfoArtist?: string;
    kMRMediaRemoteNowPlayingInfoAlbum?: string;
    kMRMediaRemoteNowPlayingInfoDuration?: number;
    kMRMediaRemoteNowPlayingInfoElapsedTime?: number;
    kMRMediaRemoteNowPlayingInfoPlaybackRate?: number;
    kMRMediaRemoteNowPlayingInfoTimestamp?: number;
  };
  error?: string;
}

const JXA_SCRIPT = `
ObjC.import("Foundation");

function run() {
  try {
    const MediaRemote = $.NSBundle.bundleWithPath(
      "/System/Library/PrivateFrameworks/MediaRemote.framework/"
    );
    MediaRemote.load;

    const MRNowPlayingRequest = $.NSClassFromString("MRNowPlayingRequest");

    if (!MRNowPlayingRequest) {
      return JSON.stringify({ error: "MRNowPlayingRequest not available", isPlaying: false, client: null, info: {} });
    }

    const playerPath = MRNowPlayingRequest.localNowPlayingPlayerPath;
    let clientConverted = null;

    if (playerPath && playerPath.client) {
      const client = playerPath.client;
      clientConverted = {
        bundleIdentifier: client.bundleIdentifier
          ? ObjC.unwrap(client.bundleIdentifier)
          : null,
        parentApplicationBundleIdentifier:
          client.parentApplicationBundleIdentifier
            ? ObjC.unwrap(client.parentApplicationBundleIdentifier)
            : null,
      };
    }

    const nowPlayingItem = MRNowPlayingRequest.localNowPlayingItem;
    let infoConverted = {};

    if (nowPlayingItem && nowPlayingItem.nowPlayingInfo) {
      const infoDict = nowPlayingItem.nowPlayingInfo;
      const enumerator = infoDict.keyEnumerator;
      let key;

      while ((key = enumerator.nextObject) && !key.isNil()) {
        const keyStr = ObjC.unwrap(key);
        const value = infoDict.objectForKey(key);

        if (value && !value.isNil()) {
          if (value.isKindOfClass($.NSDate)) {
            infoConverted[keyStr] = value.timeIntervalSince1970 * 1000;
          } else if (value.isKindOfClass($.NSNumber)) {
            infoConverted[keyStr] = ObjC.unwrap(value);
          } else if (value.isKindOfClass($.NSString)) {
            infoConverted[keyStr] = ObjC.unwrap(value);
          }
        }
      }
    }

    const isPlaying = MRNowPlayingRequest.localIsPlaying;

    return JSON.stringify({
      isPlaying: isPlaying,
      client: clientConverted,
      info: infoConverted,
    });
  } catch (e) {
    return JSON.stringify({ error: e.toString(), isPlaying: false, client: null, info: {} });
  }
}
`;

async function getNowPlayingInfo(): Promise<NowPlayingInfo> {
  try {
    const result = await $`osascript -l JavaScript -e ${JXA_SCRIPT}`.text();
    const parsed: JXAResult = JSON.parse(result.trim());

    if (parsed.error) {
      console.error("JXA Error:", parsed.error);
      return {
        title: null,
        artist: null,
        album: null,
        duration: null,
        elapsedTime: null,
        timestamp: null,
        playbackRate: null,
        bundleIdentifier: null,
        isPlaying: false,
      };
    }

    const bundleId =
      parsed.client?.parentApplicationBundleIdentifier ||
      parsed.client?.bundleIdentifier ||
      null;

    return {
      title: parsed.info.kMRMediaRemoteNowPlayingInfoTitle || null,
      artist: parsed.info.kMRMediaRemoteNowPlayingInfoArtist || null,
      album: parsed.info.kMRMediaRemoteNowPlayingInfoAlbum || null,
      duration: parsed.info.kMRMediaRemoteNowPlayingInfoDuration ?? null,
      elapsedTime: parsed.info.kMRMediaRemoteNowPlayingInfoElapsedTime ?? null,
      timestamp: parsed.info.kMRMediaRemoteNowPlayingInfoTimestamp ?? null,
      playbackRate: parsed.info.kMRMediaRemoteNowPlayingInfoPlaybackRate ?? null,
      bundleIdentifier: bundleId,
      isPlaying: parsed.isPlaying,
    };
  } catch (error) {
    console.error("Failed to get now playing info:", error);
    return {
      title: null,
      artist: null,
      album: null,
      duration: null,
      elapsedTime: null,
      timestamp: null,
      playbackRate: null,
      bundleIdentifier: null,
      isPlaying: false,
    };
  }
}

function isTelegramPlaying(info: NowPlayingInfo): boolean {
  if (!info.bundleIdentifier) return false;
  return TELEGRAM_BUNDLE_IDS.some(
    (id) => info.bundleIdentifier?.toLowerCase() === id.toLowerCase()
  );
}

async function fetchArtworkUrl(title: string, artist: string | null): Promise<string | null> {
  const cacheKey = `${title}-${artist || ""}`;

  if (artworkCache.has(cacheKey)) {
    return artworkCache.get(cacheKey) || null;
  }

  try {
    const searchTerm = artist ? `${title} ${artist}` : title;
    const encodedTerm = encodeURIComponent(searchTerm);
    const url = `https://itunes.apple.com/search?term=${encodedTerm}&media=music&entity=song&limit=5`;

    const response = await fetch(url);
    if (!response.ok) {
      artworkCache.set(cacheKey, null);
      return null;
    }

    const data = (await response.json()) as iTunesSearchResult;

    if (data.resultCount > 0 && data.results[0]?.artworkUrl100) {
      const artworkUrl = data.results[0].artworkUrl100.replace("100x100", "512x512");
      artworkCache.set(cacheKey, artworkUrl);
      console.log(`🎨 Found artwork for "${title}"`);
      return artworkUrl;
    }

    artworkCache.set(cacheKey, null);
    return null;
  } catch {
    artworkCache.set(cacheKey, null);
    return null;
  }
}

async function main() {
  console.log("🎵 Telegram Audio Discord Rich Presence (Tray App)");
  console.log("===================================================");

  if (DISCORD_CLIENT_ID === "YOUR_CLIENT_ID_HERE") {
    console.error("\n⚠️  Please set DISCORD_CLIENT_ID environment variable!");
    console.error("Example: DISCORD_CLIENT_ID=123456789 bun run tray.ts");
    process.exit(1);
  }

  // Initialize Discord RPC
  const rpc = new Client({ clientId: DISCORD_CLIENT_ID });

  rpc.on("ready", () => {
    console.log(`✅ Connected to Discord as ${rpc.user?.username}`);
    isConnected = true;
  });

  rpc.on("disconnected", () => {
    console.log("❌ Disconnected from Discord");
    isConnected = false;
  });

  // Connect to Discord (non-blocking - tray will still appear)
  const connectToDiscord = async () => {
    try {
      console.log("🔌 Connecting to Discord...");
      await rpc.login();
    } catch (error) {
      console.error("⚠️  Failed to connect to Discord:", error instanceof Error ? error.message : error);
      console.error("   Will retry in 30 seconds...");
      setTimeout(connectToDiscord, 30000);
    }
  };

  // Start connection attempt in background
  connectToDiscord();

  // Create system tray
  const systray = new SysTray({
    menu: {
      icon: ICON_PLAYING,
      isTemplateIcon: true,  // Makes macOS treat this as a template image (auto-tints for light/dark mode)
      title: "",
      tooltip: "Telegram Discord Presence",
      items: [
        {
          title: "Telegram → Discord",
          enabled: false,
          tooltip: "Status",
        },
        SysTray.separator,
        {
          title: "⏸️ Pause",
          enabled: true,
          tooltip: "Pause/Resume presence updates",
        },
        SysTray.separator,
        {
          title: "🚪 Quit",
          enabled: true,
          tooltip: "Exit the application",
        },
      ],
    },
    debug: false,
    copyDir: true,
  });

  systray.onClick((action: ClickEvent) => {
    const title = action.item.title;

    if (title === "⏸️ Pause") {
      isPaused = true;
      systray.sendAction({
        type: "update-item",
        item: {
          ...action.item,
          title: "▶️ Resume",
        },
        seq_id: action.seq_id,
      });
      systray.sendAction({
        type: "update-menu",
        menu: {
          icon: ICON_PAUSED,
          title: "",
          tooltip: "Telegram Discord Presence (Paused)",
          items: [],
        },
      });
      rpc.user?.clearActivity();
      console.log("⏸️ Paused");
    } else if (title === "▶️ Resume") {
      isPaused = false;
      systray.sendAction({
        type: "update-item",
        item: {
          ...action.item,
          title: "⏸️ Pause",
        },
        seq_id: action.seq_id,
      });
      systray.sendAction({
        type: "update-menu",
        menu: {
          icon: ICON_PLAYING,
          title: "",
          tooltip: "Telegram Discord Presence",
          items: [],
        },
      });
      console.log("▶️ Resumed");
    } else if (title === "🚪 Quit") {
      console.log("👋 Quitting...");
      rpc.user?.clearActivity();
      rpc.destroy();
      systray.kill(false);
      process.exit(0);
    }
  });

  await systray.ready();
  console.log("🔔 System tray ready");
  console.log("🔍 Monitoring for Telegram audio playback...\n");

  // Main update loop
  async function updatePresence() {
    if (!isConnected || isPaused) return;

    const info = await getNowPlayingInfo();

    if (isTelegramPlaying(info) && info.title && info.isPlaying && info.playbackRate && info.playbackRate > 0) {
      const trackId = `${info.title}-${info.artist}-${info.album}`;
      const isNewTrack = trackId !== lastTrack;

      if (isNewTrack) {
        console.log(`🎶 Now Playing: ${info.title}`);
        if (info.artist) console.log(`   Artist: ${info.artist}`);
        if (info.album) console.log(`   Album: ${info.album}`);
        console.log("");
        lastTrack = trackId;
        currentTrackId = trackId;
        currentTrackStartTime = Date.now();
      }

      const artworkUrl = await fetchArtworkUrl(info.title, info.artist);

      let details = info.title || "Unknown Track";
      // Discord requires details to be at least 2 characters long
      if (details.length < 2) {
        details = `${details} `;
      }
      let state = info.artist || "Unknown Artist";
      if (info.duration) {
        const mins = Math.floor(info.duration / 60);
        const secs = Math.floor(info.duration % 60);
        state = `${state} • ${mins}:${secs.toString().padStart(2, "0")}`;
      }

      const now = Date.now();
      let actualElapsedMs: number | null = null;

      if (info.elapsedTime !== null && info.timestamp !== null) {
        const timeSinceUpdate = now - info.timestamp;
        actualElapsedMs = info.elapsedTime * 1000 + timeSinceUpdate;
      }

      const startTimestamp =
        actualElapsedMs !== null
          ? now - actualElapsedMs
          : currentTrackStartTime || now;
      const endTimestamp =
        info.duration !== null
          ? startTimestamp + info.duration * 1000
          : undefined;

      const displayName = info.artist
        ? `${info.title} - ${info.artist}`
        : info.title || "Telegram";

      await rpc.user?.setActivity({
        name: displayName,
        type: ActivityType.Listening,
        details: details.substring(0, 128),
        state: state.substring(0, 128),
        startTimestamp: new Date(startTimestamp),
        endTimestamp: endTimestamp ? new Date(endTimestamp) : undefined,
        largeImageKey: artworkUrl || "telegram",
        largeImageText: info.album || info.title || "Telegram",
        smallImageKey: "telegram",
        smallImageText: info.title || "Playing via Telegram",
      });
    } else {
      if (lastTrack !== null) {
        console.log("⏸️ Playback stopped or paused\n");
        lastTrack = null;
        currentTrackId = null;
        currentTrackStartTime = null;
        await rpc.user?.clearActivity();
      }
    }
  }

  // Initial update
  await updatePresence();

  // Poll for changes
  setInterval(updatePresence, POLL_INTERVAL);

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\n\n👋 Shutting down...");
    await rpc.user?.clearActivity();
    await rpc.destroy();
    systray.kill(false);
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await rpc.user?.clearActivity();
    await rpc.destroy();
    systray.kill(false);
    process.exit(0);
  });
}

main().catch(console.error);
