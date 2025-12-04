import { Client } from "@xhayper/discord-rpc";
import { ActivityType } from "discord-api-types/v10";
import { $ } from "bun";

// Check for test mode
const TEST_MODE = process.argv.includes("--test");

// Artwork cache to avoid repeated API calls
const artworkCache = new Map<string, string | null>();

// Track start time cache (since Telegram doesn't provide elapsedTime)
let currentTrackId: string | null = null;
let currentTrackStartTime: number | null = null;

// Discord Application Client ID - You need to create an app at https://discord.com/developers/applications
// Set this in your environment or replace with your actual client ID
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "YOUR_CLIENT_ID_HERE";

// Telegram bundle identifiers (macOS)
const TELEGRAM_BUNDLE_IDS = [
  "ru.keepcoder.Telegram", // Telegram for macOS (native)
  "org.telegram.desktop", // Telegram Desktop
  "com.tdesktop.Telegram", // Alternative Telegram Desktop
];

// Polling interval in milliseconds
const POLL_INTERVAL = 5000;

interface NowPlayingInfo {
  title: string | null;
  artist: string | null;
  album: string | null;
  duration: number | null;
  elapsedTime: number | null;
  timestamp: number | null; // Unix timestamp (ms) when elapsedTime was recorded
  playbackRate: number | null;
  bundleIdentifier: string | null;
  isPlaying: boolean;
}

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

// JXA Script to get Now Playing info on macOS 15.4+
// This bypasses the MediaRemote entitlement check
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

    // Get client info (which app is playing)
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

    // Get now playing info (track metadata)
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

    // Get playing state
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
    // Use JXA to get Now Playing info (works on macOS 15.4+)
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

    // Get bundle identifier from client or parent app
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

  // Check cache first
  if (artworkCache.has(cacheKey)) {
    return artworkCache.get(cacheKey) || null;
  }

  try {
    // Build search query
    const searchTerm = artist ? `${title} ${artist}` : title;
    const encodedTerm = encodeURIComponent(searchTerm);
    const url = `https://itunes.apple.com/search?term=${encodedTerm}&media=music&entity=song&limit=5`;

    const response = await fetch(url);
    if (!response.ok) {
      console.error("iTunes API error:", response.status);
      artworkCache.set(cacheKey, null);
      return null;
    }

    const data = (await response.json()) as iTunesSearchResult;

    if (data.resultCount > 0 && data.results[0]?.artworkUrl100) {
      // Get higher resolution artwork (replace 100x100 with 512x512)
      const artworkUrl = data.results[0].artworkUrl100.replace("100x100", "512x512");
      artworkCache.set(cacheKey, artworkUrl);
      console.log(`🎨 Found artwork for "${title}"`);
      return artworkUrl;
    }

    // No artwork found
    artworkCache.set(cacheKey, null);
    return null;
  } catch (error) {
    console.error("Failed to fetch artwork:", error);
    artworkCache.set(cacheKey, null);
    return null;
  }
}

async function testMode() {
  console.log("🎵 Telegram Audio Discord Rich Presence - TEST MODE");
  console.log("====================================================");
  console.log("Testing Now Playing detection (no Discord connection)\n");

  const runTest = async () => {
    console.log("📡 Fetching Now Playing info...\n");
    const info = await getNowPlayingInfo();

    console.log("Raw info:", JSON.stringify(info, null, 2));
    console.log("");

    if (info.bundleIdentifier) {
      console.log(`📱 App: ${info.bundleIdentifier}`);
    } else {
      console.log("📱 App: (none detected)");
    }

    if (isTelegramPlaying(info)) {
      console.log("✅ Telegram IS the current player");
    } else {
      console.log("❌ Telegram is NOT the current player");
      if (info.bundleIdentifier) {
        console.log(`   Current player: ${info.bundleIdentifier}`);
      }
    }

    console.log("");
    if (info.isPlaying && info.playbackRate && info.playbackRate > 0) {
      console.log("▶️  Playback: PLAYING");
    } else if (info.isPlaying) {
      console.log("⏸️  Playback: PAUSED (rate = 0)");
    } else {
      console.log("⏹️  Playback: STOPPED");
    }

    if (info.title) {
      console.log(`🎵 Title: ${info.title}`);
    }
    if (info.artist) {
      console.log(`🎤 Artist: ${info.artist}`);
    }
    if (info.album) {
      console.log(`💿 Album: ${info.album}`);
    }
    if (info.duration) {
      const mins = Math.floor(info.duration / 60);
      const secs = Math.floor(info.duration % 60);
      console.log(`⏱️  Duration: ${mins}:${secs.toString().padStart(2, "0")}`);
    }
    if (info.elapsedTime !== null) {
      const mins = Math.floor(info.elapsedTime / 60);
      const secs = Math.floor(info.elapsedTime % 60);
      console.log(`⏳ Elapsed: ${mins}:${secs.toString().padStart(2, "0")}`);
    }

    console.log("\n" + "=".repeat(50) + "\n");
  };

  // Run once immediately
  await runTest();

  // Then poll every 5 seconds
  console.log("Polling every 5 seconds... Press Ctrl+C to stop.\n");
  setInterval(runTest, POLL_INTERVAL);
}

async function main() {
  // Handle test mode
  if (TEST_MODE) {
    await testMode();
    return;
  }

  console.log("🎵 Telegram Audio Discord Rich Presence");
  console.log("========================================");

  if (DISCORD_CLIENT_ID === "YOUR_CLIENT_ID_HERE") {
    console.error("\n⚠️  Please set your Discord Client ID!");
    console.error("   1. Go to https://discord.com/developers/applications");
    console.error("   2. Create a new application");
    console.error('   3. Add an image named "telegram" in Rich Presence > Art Assets');
    console.error('   4. (Optional) Add an image named "trail" for the small icon');
    console.error("   5. Copy the Application ID");
    console.error("   6. Set DISCORD_CLIENT_ID environment variable or update this file\n");
    console.error("Example: DISCORD_CLIENT_ID=123456789 bun run index.ts");
    console.error("\nTip: Use --test flag to test Now Playing detection without Discord:");
    console.error("     bun run index.ts --test");
    process.exit(1);
  }

  // Initialize Discord RPC
  const rpc = new Client({ clientId: DISCORD_CLIENT_ID });

  let isConnected = false;
  let lastTrack: string | null = null;

  rpc.on("ready", () => {
    console.log(`✅ Connected to Discord as ${rpc.user?.username}`);
    isConnected = true;
  });

  rpc.on("disconnected", () => {
    console.log("❌ Disconnected from Discord");
    isConnected = false;
  });

  // Connect to Discord
  try {
    await rpc.login();
  } catch (error) {
    console.error("Failed to connect to Discord:", error);
    console.error("\nMake sure Discord is running on your computer.");
    process.exit(1);
  }

  console.log("\n🔍 Monitoring for Telegram audio playback...\n");

  // Main polling loop
  async function updatePresence() {
    if (!isConnected) return;

    const info = await getNowPlayingInfo();

    // Check if Telegram is playing audio
    if (isTelegramPlaying(info) && info.title && info.isPlaying && info.playbackRate && info.playbackRate > 0) {
      const trackId = `${info.title}-${info.artist}-${info.album}`;
      const isNewTrack = trackId !== lastTrack;

      // Only log when track changes
      if (isNewTrack) {
        console.log(`🎶 Now Playing: ${info.title}`);
        if (info.artist) console.log(`   Artist: ${info.artist}`);
        if (info.album) console.log(`   Album: ${info.album}`);
        console.log("");
        lastTrack = trackId;

        // Track when this song started (since Telegram doesn't provide elapsedTime)
        currentTrackId = trackId;
        currentTrackStartTime = Date.now();
      }

      // Fetch artwork (uses cache for repeated calls)
      const artworkUrl = await fetchArtworkUrl(info.title, info.artist);

      // Build presence details
      let details = info.title || "Unknown Track";
      // Discord requires details to be at least 2 characters long
      if (details.length < 2) {
        details = `${details} `;
      }

      // Build state with artist and duration
      let state = info.artist || "Unknown Artist";
      if (info.duration) {
        const mins = Math.floor(info.duration / 60);
        const secs = Math.floor(info.duration % 60);
        const durationStr = `${mins}:${secs.toString().padStart(2, "0")}`;
        state = `${state} • ${durationStr}`;
      }

      // Calculate timestamps for progress bar
      // elapsedTime is the elapsed time at the moment of timestamp, so we need to add time since then
      const now = Date.now();
      let actualElapsedMs: number | null = null;

      if (info.elapsedTime !== null && info.timestamp !== null) {
        // timestamp is in ms (converted from NSDate.timeIntervalSince1970 * 1000 in JXA)
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

      await rpc.user?.setActivity({
        type: ActivityType.Listening,
        details: details.substring(0, 128), // Discord limit
        state: state.substring(0, 128),
        startTimestamp: new Date(startTimestamp),
        endTimestamp: endTimestamp ? new Date(endTimestamp) : undefined,
        largeImageKey: artworkUrl || "telegram", // Use album art if available, fallback to telegram icon
        largeImageText: info.album || "Telegram",
        smallImageKey: "telegram", // Telegram icon as small badge
        smallImageText: "Playing via Telegram",
      });
    } else {
      // Clear presence if not playing from Telegram
      if (lastTrack !== null) {
        console.log("⏸️  Playback stopped or paused\n");
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
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await rpc.user?.clearActivity();
    await rpc.destroy();
    process.exit(0);
  });

  // Keep the process running
  console.log("Press Ctrl+C to stop.\n");
}

main().catch(console.error);
