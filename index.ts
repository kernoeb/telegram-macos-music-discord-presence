import { Client } from "@xhayper/discord-rpc";
import { ActivityType } from "discord-api-types/v10";
import { $ } from "bun";

// Set to true at compile time via --define
declare const IS_COMPILED: boolean | undefined;

// CLI arguments
const TEST_MODE = process.argv.includes("--test");
const TRAY_MODE = process.argv.includes("--tray") || (typeof IS_COMPILED !== "undefined" && IS_COMPILED);

// Discord Application Client ID
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "YOUR_CLIENT_ID_HERE";

// Supported media source bundle identifiers (macOS)
const TELEGRAM_BUNDLE_IDS = [
  "ru.keepcoder.Telegram",
  "org.telegram.desktop",
  "com.tdesktop.Telegram",
];

// Check if a PID belongs to YouTube Music PWA
const ytMusicPidCache = new Map<number, { isYtMusic: boolean; timestamp: number }>();
const YT_MUSIC_CACHE_TTL = 30000; // 30 seconds

async function isYouTubeMusicPid(pid: number): Promise<boolean> {
  const cached = ytMusicPidCache.get(pid);
  const now = Date.now();
  if (cached && now - cached.timestamp < YT_MUSIC_CACHE_TTL) {
    return cached.isYtMusic;
  }

  try {
    const result = await $`ps -p ${pid} -o args=`.quiet().text();
    const isYtMusic = result.toLowerCase().includes("youtube music.app");
    ytMusicPidCache.set(pid, { isYtMusic, timestamp: now });
    return isYtMusic;
  } catch {
    ytMusicPidCache.set(pid, { isYtMusic: false, timestamp: now });
    return false;
  }
}

// Polling interval in milliseconds
const POLL_INTERVAL = 5000;

// Artwork cache to avoid repeated API calls
const artworkCache = new Map<string, string | null>();

// Track state
let currentTrackId: string | null = null;
let currentTrackStartTime: number | null = null;
let lastTrack: string | null = null;
let isPaused = false;
let isConnected = false;

// Music note icon for tray (44x44 PNG @ 144 DPI for Retina menu bar)
const TRAY_ICON = "iVBORw0KGgoAAAANSUhEUgAAACwAAAAsCAYAAAAehFoBAAAAAXNSR0IArs4c6QAAAHhlWElmTU0AKgAAAAgABAEaAAUAAAABAAAAPgEbAAUAAAABAAAARgEoAAMAAAABAAIAAIdpAAQAAAABAAAATgAAAAAAAACQAAAAAQAAAJAAAAABAAOgAQADAAAAAQABAACgAgAEAAAAAQAAACygAwAEAAAAAQAAACwAAAAALuNfAgAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAASVJREFUWAnt1uEKgzAMBGAde/9X3jwkEEosF63mCvbHWrXq1zODLsvb3gTmTmC9g//bWvTcdWvR+cy5T2by1blHC8k89/KKo5cxsLNpP5qwXxyzKD/fxmUJGwB9Ju2yhD04k7YEGHgWLVESPm2MeyUik7BH99KWTNjj27QlE/bgNm15sMdjLA+eriSmS7gU3H7eFtMeR/Mfr2Eg0Foce/w42GA7Ow8vA3u4jZm+HAxklPZR2UiALdkIbteslwIb6ihdXJcEGzzqpwN/o1Uw59pdFHPPiDlpcBXUFpsqiWos0DRYAUuDVbAUWAlLgTFJqdE1rIJ+wXd/CWrnP+KP19vQZBZJgfHAK+hRWDho8Fn0SGwanEWPxp4C4ya0XoncAd3fOuHvH08dWFF9sJxuAAAAAElFTkSuQmCC";

interface NowPlayingInfo {
  title: string | null;
  artist: string | null;
  album: string | null;
  duration: number | null;
  elapsedTime: number | null;
  timestamp: number | null;
  playbackRate: number | null;
  bundleIdentifier: string | null;
  processIdentifier: number | null;
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

interface DeezerSearchResult {
  data: Array<{
    title?: string;
    artist?: { name?: string };
    album?: {
      cover_xl?: string;
      cover_big?: string;
      cover_medium?: string;
      cover_small?: string;
      title?: string;
    };
  }>;
}

interface JXAResult {
  isPlaying: boolean;
  client: {
    bundleIdentifier: string | null;
    parentApplicationBundleIdentifier: string | null;
    processIdentifier: number | null;
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
        processIdentifier: client.processIdentifier ?? null,
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
        processIdentifier: null,
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
      processIdentifier: parsed.client?.processIdentifier ?? null,
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
      processIdentifier: null,
      isPlaying: false,
    };
  }
}

type MediaSource = "telegram" | "youtube-music" | null;

async function getMediaSource(info: NowPlayingInfo): Promise<MediaSource> {
  if (!info.bundleIdentifier) return null;

  const bundleId = info.bundleIdentifier;

  // Check Telegram
  if (TELEGRAM_BUNDLE_IDS.some((id) => bundleId.toLowerCase() === id.toLowerCase())) {
    return "telegram";
  }

  // Check for app_mode_loader (Chromium PWA loader) - verify it's YouTube Music via PID
  if (bundleId === "app_mode_loader" && info.processIdentifier) {
    if (await isYouTubeMusicPid(info.processIdentifier)) {
      return "youtube-music";
    }
  }

  return null;
}

function normalizeSearchTerm(term: string): string {
  return term
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove diacritics (é -> e, etc.)
    .replace(/[!?.,;:'"()[\]{}]/g, "") // Remove punctuation
    .replace(/\s+/g, " ") // Collapse multiple spaces
    .trim();
}

function getFirstArtist(artist: string): string {
  // Handle "Artist1, Artist2" or "Artist1 & Artist2" or "Artist1 feat. Artist2"
  const separators = [",", " & ", " feat.", " ft.", " featuring ", " x "];
  let result = artist;
  for (const sep of separators) {
    const idx = result.toLowerCase().indexOf(sep.toLowerCase());
    if (idx > 0) {
      result = result.substring(0, idx);
    }
  }
  return result.trim();
}

function matchesResult(
  result: { trackName?: string; artistName?: string },
  expectedTitle: string,
  expectedArtist: string | null
): boolean {
  const resultTrack = normalizeSearchTerm(result.trackName || "").toLowerCase();
  const resultArtist = normalizeSearchTerm(result.artistName || "").toLowerCase();
  const title = expectedTitle.toLowerCase();
  const artist = expectedArtist?.toLowerCase() || "";

  // Check if artist matches (result artist contains our artist OR our artist contains result artist)
  const artistMatches = !expectedArtist ||
    resultArtist.includes(artist) ||
    artist.includes(resultArtist) ||
    resultArtist.split(/\s+/).some(word => word.length > 2 && artist.includes(word));

  // Check if title has any overlap (at least one significant word matches)
  const titleWords = title.split(/\s+/).filter(w => w.length > 2);
  const resultWords = resultTrack.split(/\s+/).filter(w => w.length > 2);
  const titleMatches = titleWords.some(word => resultWords.includes(word)) ||
    resultWords.some(word => titleWords.includes(word));

  return artistMatches && (titleMatches || resultTrack.includes(title) || title.includes(resultTrack));
}

async function searchItunes(
  searchTerm: string,
  expectedTitle: string,
  expectedArtist: string | null
): Promise<string | null> {
  const encodedTerm = encodeURIComponent(searchTerm);
  const url = `https://itunes.apple.com/search?term=${encodedTerm}&media=music&entity=song&limit=10`;

  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as iTunesSearchResult;

  // Find first result that actually matches our title/artist
  for (const result of data.results) {
    if (result.artworkUrl100 && matchesResult(result, expectedTitle, expectedArtist)) {
      return result.artworkUrl100.replace("100x100", "512x512");
    }
  }
  return null;
}

async function searchDeezer(
  searchTerm: string,
  expectedTitle: string,
  expectedArtist: string | null
): Promise<string | null> {
  const url = `https://api.deezer.com/search?q=${encodeURIComponent(searchTerm)}&limit=10`;

  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as DeezerSearchResult;
  if (!data.data) return null;

  for (const track of data.data) {
    if (matchesResult({
      trackName: track.title,
      artistName: track.artist?.name,
    }, expectedTitle, expectedArtist)) {
      const artwork =
        track.album?.cover_xl ||
        track.album?.cover_big ||
        track.album?.cover_medium ||
        track.album?.cover_small;

      if (artwork) return artwork;
    }
  }

  return null;
}

async function fetchArtworkUrl(title: string, artist: string | null): Promise<string | null> {
  const cacheKey = `${title}-${artist || ""}`;

  if (artworkCache.has(cacheKey)) {
    return artworkCache.get(cacheKey) || null;
  }

  try {
    const normalizedTitle = normalizeSearchTerm(title);
    const normalizedArtist = artist ? normalizeSearchTerm(artist) : null;
    const firstArtistRaw = artist ? getFirstArtist(artist).trim() : null;
    const firstArtist = firstArtistRaw ? normalizeSearchTerm(firstArtistRaw) : null;
    const expectedArtist = firstArtist || normalizedArtist;

    // Try a mix of raw and normalized search terms to handle stylized titles
    const searchStrategies: string[] = [];

    // Raw text (keeps punctuation like ! or ? that some APIs use for exact match)
    if (artist) searchStrategies.push(`${title.trim()} ${artist.trim()}`);
    searchStrategies.push(title.trim());

    // Normalized variants
    if (normalizedArtist) searchStrategies.push(`${normalizedTitle} ${normalizedArtist}`);
    if (firstArtist && firstArtist !== normalizedArtist) searchStrategies.push(`${normalizedTitle} ${firstArtist}`);
    searchStrategies.push(normalizedTitle);
    if (firstArtist) searchStrategies.push(firstArtist);

    for (const searchTerm of searchStrategies) {
      // Prefer Deezer (better coverage for niche/indie tracks), then fall back to iTunes
      const deezerArtwork = await searchDeezer(searchTerm, normalizedTitle, expectedArtist);
      if (deezerArtwork) {
        artworkCache.set(cacheKey, deezerArtwork);
        console.log(`🎨 Found artwork via Deezer for "${title}"`);
        return deezerArtwork;
      }

      const itunesArtwork = await searchItunes(searchTerm, normalizedTitle, expectedArtist);
      if (itunesArtwork) {
        artworkCache.set(cacheKey, itunesArtwork);
        console.log(`🎨 Found artwork via iTunes for "${title}"`);
        return itunesArtwork;
      }
    }

    artworkCache.set(cacheKey, null);
    return null;
  } catch (error) {
    console.error("Failed to fetch artwork:", error);
    artworkCache.set(cacheKey, null);
    return null;
  }
}

async function testMode() {
  console.log("🎵 Music Discord Rich Presence - TEST MODE");
  console.log("==========================================");
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

    const source = await getMediaSource(info);
    if (source === "telegram") {
      console.log("✅ Telegram IS the current player");
    } else if (source === "youtube-music") {
      console.log("✅ YouTube Music IS the current player");
    } else {
      console.log("❌ No supported media source detected");
      if (info.bundleIdentifier) {
        console.log(`   Current player: ${info.bundleIdentifier} (PID: ${info.processIdentifier})`);
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

  await runTest();
  console.log("Polling every 5 seconds... Press Ctrl+C to stop.\n");
  setInterval(runTest, POLL_INTERVAL);
}

async function main() {
  // Handle test mode
  if (TEST_MODE) {
    await testMode();
    return;
  }

  const modeLabel = TRAY_MODE ? "(Tray App)" : "";
  console.log(`🎵 Music Discord Rich Presence ${modeLabel}`);
  console.log("=".repeat(36 + modeLabel.length));

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

  rpc.on("ready", () => {
    console.log(`✅ Connected to Discord as ${rpc.user?.username}`);
    isConnected = true;
  });

  rpc.on("disconnected", () => {
    console.log("❌ Disconnected from Discord");
    isConnected = false;
  });

  // Systray instance (only used in tray mode)
  let systray: InstanceType<typeof import("systray2").default> | null = null;

  // Connect to Discord
  const connectToDiscord = async () => {
    try {
      console.log("🔌 Connecting to Discord...");
      await rpc.login();
    } catch (error) {
      console.error("⚠️  Failed to connect to Discord:", error instanceof Error ? error.message : error);
      if (TRAY_MODE) {
        console.error("   Will retry in 30 seconds...");
        setTimeout(connectToDiscord, 30000);
      } else {
        console.error("\nMake sure Discord is running on your computer.");
        process.exit(1);
      }
    }
  };

  // Setup system tray if in tray mode
  if (TRAY_MODE) {
    const SysTray = require("systray2").default;
    type ClickEvent = import("systray2").ClickEvent;

    systray = new SysTray({
      menu: {
        icon: TRAY_ICON,
        isTemplateIcon: true,
        title: "",
        tooltip: "Music Discord Presence",
        items: [
          {
            title: "Music → Discord",
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

    systray!.onClick((action: ClickEvent) => {
      const title = action.item.title;

      if (title === "⏸️ Pause") {
        isPaused = true;
        systray!.sendAction({
          type: "update-item",
          item: { ...action.item, title: "▶️ Resume" },
          seq_id: action.seq_id,
        });
        systray!.sendAction({
          type: "update-menu",
          menu: {
            icon: TRAY_ICON,
            title: "",
            tooltip: "Music Discord Presence (Paused)",
            items: [],
          },
        });
        rpc.user?.clearActivity();
        console.log("⏸️ Paused");
      } else if (title === "▶️ Resume") {
        isPaused = false;
        systray!.sendAction({
          type: "update-item",
          item: { ...action.item, title: "⏸️ Pause" },
          seq_id: action.seq_id,
        });
        systray!.sendAction({
          type: "update-menu",
          menu: {
            icon: TRAY_ICON,
            title: "",
            tooltip: "Music Discord Presence",
            items: [],
          },
        });
        console.log("▶️ Resumed");
      } else if (title === "🚪 Quit") {
        console.log("👋 Quitting...");
        rpc.user?.clearActivity();
        rpc.destroy();
        systray!.kill(false);
        process.exit(0);
      }
    });

    await systray!.ready();
    console.log("🔔 System tray ready");

    // Start connection attempt in background (non-blocking for tray)
    connectToDiscord();
  } else {
    // CLI mode - connect and block
    await connectToDiscord();
  }

  console.log("🔍 Monitoring for Telegram & YouTube Music playback...\n");

  // Main update loop
  async function updatePresence() {
    if (!isConnected || isPaused) return;

    const info = await getNowPlayingInfo();
    const mediaSource = await getMediaSource(info);
    const isPlaying = info.isPlaying && info.playbackRate && info.playbackRate > 0;

    if (mediaSource && info.title && isPlaying) {
      const trackId = `${info.title}-${info.artist}-${info.album}`;
      const isNewTrack = trackId !== lastTrack;

      if (isNewTrack) {
        const sourceLabel = mediaSource === "youtube-music" ? "YouTube Music" : "Telegram";
        console.log(`🎶 Now Playing (${sourceLabel}): ${info.title}`);
        if (info.artist) console.log(`   Artist: ${info.artist}`);
        if (info.album) console.log(`   Album: ${info.album}`);
        console.log("");
        lastTrack = trackId;
        currentTrackId = trackId;
        currentTrackStartTime = Date.now();
      }

      const artworkUrl = await fetchArtworkUrl(info.title, info.artist);

      let details = info.title || "Unknown Track";
      if (details.length < 2) details = `${details} `;
      if (details.length > 127) details = details.substring(0, 127);

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

      let displayName = info.artist
        ? `${info.title} - ${info.artist}`
        : info.title || "Music";

      if (displayName.length < 2) displayName = `${displayName} `;
      if (displayName.length > 127) displayName = displayName.substring(0, 127);

      // Choose appropriate icons/labels based on source
      const smallImageKey = mediaSource === "youtube-music" ? "youtube-music" : "telegram";
      const fallbackImage = mediaSource === "youtube-music" ? "youtube-music" : "telegram";
      const sourceText = mediaSource === "youtube-music" ? "YouTube Music" : "Telegram";

      // Discord needs at least 2 characters for title
      if (info.title?.length === 1) info.title = info.title + ' ';
      if (info.title?.length > 127) info.title = info.title.substring(0, 127);

      if (info.album) {
        if (info.album.length === 1) info.album = info.album + ' ';
        if (info.album.length > 127) info.album = info.album.substring(0, 127);
      }

      await rpc.user?.setActivity({
        name: displayName,
        type: ActivityType.Listening,
        details: details.substring(0, 128),
        state: state.substring(0, 128),
        startTimestamp: new Date(startTimestamp),
        endTimestamp: endTimestamp ? new Date(endTimestamp) : undefined,
        largeImageKey: artworkUrl || fallbackImage,
        largeImageText: info.album || info.title || sourceText,
        smallImageKey: smallImageKey,
        smallImageText: info.title || `Playing via ${sourceText}`,
      });
    } else {
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
  const shutdown = async () => {
    console.log("\n\n👋 Shutting down...");
    await rpc.user?.clearActivity();
    await rpc.destroy();
    if (systray) {
      systray.kill(false);
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("Press Ctrl+C to stop.\n");
}

main().catch(console.error);
