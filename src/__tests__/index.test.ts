import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// ---------------------------------------------------------------------------
// Capture tool handlers registered via server.tool(...)
// ---------------------------------------------------------------------------
const toolHandlers = new Map<string, Function>();

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  return {
    McpServer: class {
      tool(name: string, _desc: string, _schema: unknown, handler: Function) {
        toolHandlers.set(name, handler);
      }
      async connect() {}
    },
  };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock mpv
// ---------------------------------------------------------------------------
vi.mock('../mpv.js', () => ({
  launch: vi.fn(),
  cleanup: vi.fn(),
  getProperty: vi.fn(),
  command: vi.fn(),
  isPlaying: vi.fn(),
  writeTempPlaylist: vi.fn().mockReturnValue('/tmp/test-playlist.txt'),
  appendUrl: vi.fn(),
  startAutoRefill: vi.fn(),
  stopAutoRefill: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock ytdlp
// ---------------------------------------------------------------------------
vi.mock('../ytdlp.js', () => ({
  fetchFeed: vi.fn(),
  fetchVideoInfo: vi.fn(),
  pickVideoFields: vi.fn((e: any) => ({
    title: e.title,
    url: e.url,
    channel: e.channel,
    duration: e.duration,
    view_count: e.view_count,
    upload_date: e.upload_date,
  })),
}));

// ---------------------------------------------------------------------------
// Mock validate.js — real functions, but checkDeps always returns null
// ---------------------------------------------------------------------------
vi.mock('../validate.js', async () => {
  const actual = await vi.importActual('../validate.js');
  return { ...actual, checkDeps: vi.fn().mockReturnValue(null) };
});

// ---------------------------------------------------------------------------
// Import mocked modules so we can manipulate them per-test
// ---------------------------------------------------------------------------
import * as mpv from '../mpv.js';
import { fetchFeed, fetchVideoInfo } from '../ytdlp.js';
import { checkDeps, FEED_URLS } from '../validate.js';

// ---------------------------------------------------------------------------
// Helper: parse the { content: [{type, text}], isError? } result
// ---------------------------------------------------------------------------
function parseResult(result: any) {
  const text = result.content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Register all tools by importing index.ts
// ---------------------------------------------------------------------------
beforeAll(async () => {
  await import('../index.js');
});

beforeEach(() => {
  vi.clearAllMocks();
  // Restore checkDeps default
  vi.mocked(checkDeps).mockReturnValue(null);
});

// ============================= play_video ==================================
describe('play_video', () => {
  const call = (args: any) => toolHandlers.get('play_video')!(args);

  it('returns error for invalid URL', async () => {
    const res = await call({ url: 'https://example.com/video', audio_only: false });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('YouTube or TikTok');
  });

  it('returns error when checkDeps returns error string', async () => {
    vi.mocked(checkDeps).mockReturnValue('mpv is not installed. Install with: brew install mpv');
    const res = await call({ url: 'https://www.youtube.com/watch?v=abc', audio_only: false });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('mpv is not installed');
  });

  it('returns error when mpv.launch throws', async () => {
    vi.mocked(mpv.launch).mockRejectedValueOnce(new Error('spawn fail'));
    const res = await call({ url: 'https://www.youtube.com/watch?v=abc', audio_only: false });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('mpv failed to start');
  });

  it('returns success with title from getProperty', async () => {
    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('Cool Video');
    const res = await call({ url: 'https://www.youtube.com/watch?v=abc', audio_only: false });
    const data = parseResult(res);
    expect(data.status).toBe('playing');
    expect(data.title).toBe('Cool Video');
    expect(data.url).toBe('https://www.youtube.com/watch?v=abc');
    expect(res.isError).toBeUndefined();
  });

  it('returns success with url as title when getProperty throws', async () => {
    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockRejectedValueOnce(new Error('loading'));
    const res = await call({ url: 'https://www.youtube.com/watch?v=abc', audio_only: false });
    const data = parseResult(res);
    expect(data.title).toBe('https://www.youtube.com/watch?v=abc');
  });

  it('includes audioOnly and startedAt when set', async () => {
    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('Music');
    const res = await call({ url: 'https://www.youtube.com/watch?v=abc', audio_only: true, timestamp: 30 });
    const data = parseResult(res);
    expect(data.audioOnly).toBe(true);
    expect(data.startedAt).toBe('30s');
    expect(mpv.launch).toHaveBeenCalledWith({ url: 'https://www.youtube.com/watch?v=abc', timestamp: 30, audioOnly: true });
  });
});

// ============================= play_playlist ===============================
describe('play_playlist', () => {
  const call = (args: any) => toolHandlers.get('play_playlist')!(args);

  it('returns error for non-YouTube URL', async () => {
    const res = await call({ url: 'https://www.tiktok.com/@user', shuffle: false });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('YouTube');
  });

  it('returns success with title, tracks, shuffle', async () => {
    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty)
      .mockResolvedValueOnce('Playlist Title')
      .mockResolvedValueOnce(42);
    const res = await call({ url: 'https://www.youtube.com/playlist?list=PLabc', shuffle: true });
    const data = parseResult(res);
    expect(data.status).toBe('playing_playlist');
    expect(data.title).toBe('Playlist Title');
    expect(data.tracks).toBe(42);
    expect(data.shuffle).toBe(true);
    expect(mpv.launch).toHaveBeenCalledWith({
      url: 'https://www.youtube.com/playlist?list=PLabc',
      shuffle: true,
      socketTimeoutMs: 15_000,
    });
  });

  it('returns error when launch throws', async () => {
    vi.mocked(mpv.launch).mockRejectedValueOnce(new Error('fail'));
    const res = await call({ url: 'https://www.youtube.com/playlist?list=PLabc', shuffle: false });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('mpv failed to start');
  });
});

// ============================= stop_video ==================================
describe('stop_video', () => {
  const call = () => toolHandlers.get('stop_video')!({});

  it('returns "No video is currently playing." when isPlaying() is false', async () => {
    vi.mocked(mpv.isPlaying).mockReturnValue(false);
    const res = await call();
    const data = parseResult(res);
    expect(data).toBe('No video is currently playing.');
    expect(mpv.cleanup).not.toHaveBeenCalled();
  });

  it('calls cleanup and returns "Video stopped." when isPlaying() is true', async () => {
    vi.mocked(mpv.isPlaying).mockReturnValue(true);
    const res = await call();
    const data = parseResult(res);
    expect(data).toBe('Video stopped.');
    expect(mpv.cleanup).toHaveBeenCalled();
  });
});

// ============================= pause_video =================================
describe('pause_video', () => {
  const call = () => toolHandlers.get('pause_video')!({});

  it('returns "Video paused." when getProperty("pause") returns true', async () => {
    vi.mocked(mpv.command).mockResolvedValueOnce({});
    vi.mocked(mpv.getProperty).mockResolvedValueOnce(true);
    const res = await call();
    const data = parseResult(res);
    expect(data).toBe('Video paused.');
    expect(mpv.command).toHaveBeenCalledWith(['cycle', 'pause']);
  });

  it('returns "Video resumed." when getProperty("pause") returns false', async () => {
    vi.mocked(mpv.command).mockResolvedValueOnce({});
    vi.mocked(mpv.getProperty).mockResolvedValueOnce(false);
    const res = await call();
    const data = parseResult(res);
    expect(data).toBe('Video resumed.');
  });
});

// ============================= seek_video ==================================
describe('seek_video', () => {
  const call = (args: any) => toolHandlers.get('seek_video')!(args);

  it('calls command with correct args and returns success', async () => {
    vi.mocked(mpv.command).mockResolvedValueOnce({});
    const res = await call({ seconds: 90 });
    const data = parseResult(res);
    expect(data).toBe('Seeked to 90s.');
    expect(mpv.command).toHaveBeenCalledWith(['seek', 90, 'absolute']);
  });

  it('returns error on exception', async () => {
    vi.mocked(mpv.command).mockRejectedValueOnce(new Error('not playing'));
    const res = await call({ seconds: 10 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not playing');
  });
});

// ============================= next_video ==================================
describe('next_video', () => {
  const call = () => toolHandlers.get('next_video')!({});

  it('returns status with title and position string "X/Y"', async () => {
    vi.mocked(mpv.command).mockResolvedValueOnce({});
    vi.mocked(mpv.getProperty)
      .mockResolvedValueOnce('Next Song')
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(10);
    const res = await call();
    const data = parseResult(res);
    expect(data.status).toBe('skipped_next');
    expect(data.title).toBe('Next Song');
    expect(data.position).toBe('3/10');
  });

  it('returns error on exception', async () => {
    vi.mocked(mpv.command).mockRejectedValueOnce(new Error('end of playlist'));
    const res = await call();
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('end of playlist');
  });
});

// ============================= prev_video ==================================
describe('prev_video', () => {
  const call = () => toolHandlers.get('prev_video')!({});

  it('returns status with title and position string', async () => {
    vi.mocked(mpv.command).mockResolvedValueOnce({});
    vi.mocked(mpv.getProperty)
      .mockResolvedValueOnce('Prev Song')
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(5);
    const res = await call();
    const data = parseResult(res);
    expect(data.status).toBe('skipped_prev');
    expect(data.title).toBe('Prev Song');
    expect(data.position).toBe('1/5');
  });
});

// ============================= get_status ==================================
describe('get_status', () => {
  const call = () => toolHandlers.get('get_status')!({});

  it('returns formatted status with number positions as "Xs"', async () => {
    vi.mocked(mpv.getProperty)
      .mockResolvedValueOnce('My Video')
      .mockResolvedValueOnce(65.7)
      .mockResolvedValueOnce(300.9)
      .mockResolvedValueOnce(false);
    const res = await call();
    const data = parseResult(res);
    expect(data.title).toBe('My Video');
    expect(data.position).toBe('65s');
    expect(data.duration).toBe('300s');
    expect(data.paused).toBe(false);
  });

  it('returns null for non-number position/duration', async () => {
    vi.mocked(mpv.getProperty)
      .mockResolvedValueOnce('My Video')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(true);
    const res = await call();
    const data = parseResult(res);
    expect(data.position).toBeNull();
    expect(data.duration).toBeNull();
  });
});

// ============================= get_youtube_feed =============================
describe('get_youtube_feed', () => {
  const call = (args: any) => toolHandlers.get('get_youtube_feed')!(args);

  it('calls fetchFeed with correct FEED_URL and returns videos', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      entries: [
        { title: 'V1', url: 'https://youtube.com/v1', channel: 'Ch1', duration: 120, view_count: 1000, upload_date: '20240101' },
      ],
    });
    const res = await call({ feed: 'subscriptions', limit: 15 });
    const data = parseResult(res);
    expect(fetchFeed).toHaveBeenCalledWith(FEED_URLS.subscriptions, 15);
    expect(data.feed).toBe('subscriptions');
    expect(data.count).toBe(1);
    expect(data.videos[0].title).toBe('V1');
  });

  it('returns error on fetchFeed failure', async () => {
    vi.mocked(fetchFeed).mockRejectedValueOnce(new Error('network error'));
    const res = await call({ feed: 'liked', limit: 10 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('network error');
  });
});

// ============================= search_youtube ==============================
describe('search_youtube', () => {
  const call = (args: any) => toolHandlers.get('search_youtube')!(args);

  it('encodes query in URL correctly', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({ entries: [] });
    await call({ query: 'hello world', limit: 10 });
    expect(fetchFeed).toHaveBeenCalledWith(
      'https://www.youtube.com/results?search_query=hello%20world',
      10,
    );
  });

  it('returns mapped video results', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      entries: [
        { title: 'Result1', url: 'https://youtube.com/r1', channel: 'C', duration: 60, view_count: 500, upload_date: '20240201' },
      ],
    });
    const res = await call({ query: 'test', limit: 5 });
    const data = parseResult(res);
    expect(data.query).toBe('test');
    expect(data.count).toBe(1);
    expect(data.videos[0].title).toBe('Result1');
  });
});

// ============================= get_video_info ==============================
describe('get_video_info', () => {
  const call = (args: any) => toolHandlers.get('get_video_info')!(args);

  it('returns full info with chapters', async () => {
    vi.mocked(fetchVideoInfo).mockResolvedValueOnce({
      title: 'Info Video',
      channel: 'Ch',
      upload_date: '20240301',
      duration: 600,
      view_count: 10000,
      like_count: 500,
      description: 'A video',
      tags: ['tag1'],
      chapters: [
        { title: 'Intro', start_time: 0, end_time: 60 },
        { title: 'Main', start_time: 60, end_time: 600 },
      ],
    });
    const res = await call({ url: 'https://www.youtube.com/watch?v=abc' });
    const data = parseResult(res);
    expect(data.title).toBe('Info Video');
    expect(data.chapters).toHaveLength(2);
    expect(data.chapters[0]).toEqual({ title: 'Intro', start: 0, end: 60 });
  });

  it('handles missing chapters (empty array)', async () => {
    vi.mocked(fetchVideoInfo).mockResolvedValueOnce({
      title: 'No Chapters', channel: 'Ch', upload_date: '20240301',
      duration: 100, view_count: 50, like_count: 5,
      description: 'desc', tags: [],
    });
    const res = await call({ url: 'https://www.youtube.com/watch?v=xyz' });
    const data = parseResult(res);
    expect(data.chapters).toEqual([]);
  });

  it('returns error for invalid URL', async () => {
    const res = await call({ url: 'https://example.com/video' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('YouTube or TikTok');
  });
});

// ============================= get_subscribed_channels ======================
describe('get_subscribed_channels', () => {
  const call = (args: any) => toolHandlers.get('get_subscribed_channels')!(args);

  it('maps entries correctly with channel_url fallback', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      entries: [
        { channel: 'Chan1', channel_url: 'https://youtube.com/@Chan1', title: 'Channel One', url: 'https://youtube.com/c/chan1' },
        { channel: 'Chan2', title: 'Channel Two', url: 'https://youtube.com/c/chan2' },
      ],
    });
    const res = await call({ limit: 30 });
    const data = parseResult(res);
    expect(data.count).toBe(2);
    expect(data.channels[0].channel_url).toBe('https://youtube.com/@Chan1');
    expect(data.channels[1].channel_url).toBe('https://youtube.com/c/chan2');
  });
});

// ============================= get_channel_videos ==========================
describe('get_channel_videos', () => {
  const call = (args: any) => toolHandlers.get('get_channel_videos')!(args);

  it('appends /videos to URL', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({ entries: [], title: 'Channel' });
    await call({ channel_url: 'https://www.youtube.com/@TestChannel', limit: 15 });
    expect(fetchFeed).toHaveBeenCalledWith('https://www.youtube.com/@TestChannel/videos', 15);
  });

  it('does not double-append if already has /videos', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({ entries: [], title: 'Channel' });
    await call({ channel_url: 'https://www.youtube.com/@TestChannel/videos', limit: 10 });
    expect(fetchFeed).toHaveBeenCalledWith('https://www.youtube.com/@TestChannel/videos', 10);
  });
});

// ============================= get_channel_shorts ==========================
describe('get_channel_shorts', () => {
  const call = (args: any) => toolHandlers.get('get_channel_shorts')!(args);

  it('fetches shorts from channel', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      entries: [
        { title: 'Short1', url: 'https://youtube.com/shorts/1', channel: 'C', duration: 30, view_count: 100, upload_date: '20240301' },
      ],
    });
    const res = await call({ channel_url: 'https://www.youtube.com/@TestChannel', limit: 15 });
    const data = parseResult(res);
    expect(data.count).toBe(1);
    expect(data.shorts[0].title).toBe('Short1');
  });

  it('returns error for non-YouTube URL', async () => {
    const res = await call({ channel_url: 'https://example.com/@test', limit: 15 });
    expect(res.isError).toBe(true);
  });
});

// ============================= get_subscription_shorts ======================
describe('get_subscription_shorts', () => {
  const call = (args: any) => toolHandlers.get('get_subscription_shorts')!(args);

  it('fetches shorts from subscribed channels', async () => {
    vi.mocked(fetchFeed)
      .mockResolvedValueOnce({
        entries: [
          { channel: 'Ch1', channel_url: 'https://www.youtube.com/@Ch1', title: 'Channel 1', url: 'https://youtube.com/c/ch1' },
        ],
      })
      .mockResolvedValueOnce({
        entries: [
          { title: 'Short1', url: 'https://youtube.com/shorts/1', duration: 15, view_count: 50, upload_date: '20240301', channel: 'Ch1' },
        ],
      });
    const res = await call({ max_channels: 15, shorts_per_channel: 3 });
    const data = parseResult(res);
    expect(data.channels_sampled).toContain('Ch1');
    expect(data.count).toBeGreaterThanOrEqual(1);
  });

  it('returns message when no subscribed channels found', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({ entries: [] });
    const res = await call({ max_channels: 15, shorts_per_channel: 3 });
    const data = parseResult(res);
    expect(data).toBe('No subscribed channels found.');
  });
});

// ============================= play_shorts =================================
describe('play_shorts', () => {
  const call = (args: any) => toolHandlers.get('play_shorts')!(args);

  it('plays shorts from channel source', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      entries: [
        { url: 'https://youtube.com/shorts/1' },
        { url: 'https://youtube.com/shorts/2' },
      ],
    });
    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('Short Title');

    const res = await call({
      source: 'channel',
      channel_url: 'https://www.youtube.com/@TestChannel',
      max_channels: 15,
      shorts_per_channel: 3,
      limit: 15,
      shuffle: false,
    });
    const data = parseResult(res);
    expect(data.status).toBe('playing_shorts');
    expect(data.total).toBe(2);
    expect(data.source).toBe('channel');
    expect(data.autoRefill).toBe(true);
    expect(mpv.writeTempPlaylist).toHaveBeenCalled();
    expect(mpv.startAutoRefill).toHaveBeenCalled();
  });

  it('requires channel_url for channel source', async () => {
    const res = await call({
      source: 'channel',
      max_channels: 15,
      shorts_per_channel: 3,
      limit: 15,
      shuffle: false,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('channel_url is required');
  });

  it('returns "No shorts found." when no shorts available', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({ entries: [] });
    const res = await call({
      source: 'channel',
      channel_url: 'https://www.youtube.com/@TestChannel',
      max_channels: 15,
      shorts_per_channel: 3,
      limit: 15,
      shuffle: false,
    });
    const data = parseResult(res);
    expect(data).toBe('No shorts found.');
  });

  it('plays shorts from subscriptions source', async () => {
    // First call: fetch subscribed channels
    vi.mocked(fetchFeed)
      .mockResolvedValueOnce({
        entries: [
          { channel: 'Ch1', channel_url: 'https://www.youtube.com/@Ch1', title: 'Ch1', url: 'https://youtube.com/c/ch1' },
        ],
      })
      // Second call: fetch shorts from channel
      .mockResolvedValueOnce({
        entries: [{ url: 'https://youtube.com/shorts/s1', upload_date: '20240301' }],
      });
    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('Sub Short');

    const res = await call({
      source: 'subscriptions',
      max_channels: 15,
      shorts_per_channel: 3,
      limit: 15,
      shuffle: false,
    });
    const data = parseResult(res);
    expect(data.status).toBe('playing_shorts');
    expect(data.source).toBe('subscriptions');
    expect(data.autoRefill).toBe(false);
  });
});

// ============================= get_tiktok_user_videos ======================
describe('get_tiktok_user_videos', () => {
  const call = (args: any) => toolHandlers.get('get_tiktok_user_videos')!(args);

  it('prepends @ to username', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      entries: [{ title: 'TT1', url: 'https://tiktok.com/v1', duration: 30, view_count: 100, like_count: 10, comment_count: 5, uploader: 'user1' }],
    });
    const res = await call({ username: 'testuser', limit: 15 });
    expect(fetchFeed).toHaveBeenCalledWith('https://www.tiktok.com/@testuser', 15);
    const data = parseResult(res);
    expect(data.username).toBe('@testuser');
  });

  it('does not double-prepend @', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({ entries: [] });
    await call({ username: '@testuser', limit: 15 });
    expect(fetchFeed).toHaveBeenCalledWith('https://www.tiktok.com/@testuser', 15);
  });
});

// ============================= play_tiktok_user ============================
describe('play_tiktok_user', () => {
  const call = (args: any) => toolHandlers.get('play_tiktok_user')!(args);

  it('fetches, writes playlist, launches, starts auto-refill', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      entries: [
        { url: 'https://tiktok.com/v1' },
        { url: 'https://tiktok.com/v2' },
      ],
    });
    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('TikTok Title');

    const res = await call({ username: 'creator', limit: 15, shuffle: false });
    const data = parseResult(res);
    expect(data.status).toBe('playing_tiktok');
    expect(data.username).toBe('@creator');
    expect(data.total).toBe(2);
    expect(data.autoRefill).toBe(true);
    expect(mpv.writeTempPlaylist).toHaveBeenCalledWith([
      'https://tiktok.com/v1',
      'https://tiktok.com/v2',
    ]);
    expect(mpv.launch).toHaveBeenCalledWith({
      playlistFile: '/tmp/test-playlist.txt',
      shuffle: false,
      socketTimeoutMs: 15_000,
    });
    expect(mpv.startAutoRefill).toHaveBeenCalled();
  });

  it('returns "No videos found." when no videos', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({ entries: [] });
    const res = await call({ username: 'empty', limit: 15, shuffle: false });
    const data = parseResult(res);
    expect(data).toBe('No videos found.');
  });

  it('returns error when fetchFeed throws', async () => {
    vi.mocked(fetchFeed).mockRejectedValueOnce(new Error('TikTok blocked'));
    const res = await call({ username: 'blocked', limit: 15, shuffle: false });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('TikTok blocked');
  });
});

// ============================= queue_video =================================
describe('queue_video', () => {
  const call = (args: any) => toolHandlers.get('queue_video')!(args);

  it('starts playback if nothing playing', async () => {
    vi.mocked(mpv.isPlaying).mockReturnValue(false);
    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('Queued Video');

    const res = await call({ url: 'https://www.youtube.com/watch?v=abc' });
    const data = parseResult(res);
    expect(data.status).toBe('playing');
    expect(data.title).toBe('Queued Video');
    expect(mpv.launch).toHaveBeenCalledWith({ url: 'https://www.youtube.com/watch?v=abc' });
  });

  it('appends to queue if already playing', async () => {
    vi.mocked(mpv.isPlaying).mockReturnValue(true);
    vi.mocked(mpv.appendUrl).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce(5);

    const res = await call({ url: 'https://www.youtube.com/watch?v=def' });
    const data = parseResult(res);
    expect(data.status).toBe('queued');
    expect(data.queuePosition).toBe(5);
    expect(mpv.appendUrl).toHaveBeenCalledWith('https://www.youtube.com/watch?v=def');
  });

  it('returns error for invalid URL', async () => {
    const res = await call({ url: 'https://example.com/video' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('YouTube or TikTok');
  });
});

// ============================= play_audio ==================================
describe('play_audio', () => {
  const call = (args: any) => toolHandlers.get('play_audio')!(args);

  it('launches with audioOnly: true', async () => {
    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('Audio Track');

    const res = await call({ url: 'https://www.youtube.com/watch?v=music' });
    const data = parseResult(res);
    expect(data.status).toBe('playing_audio');
    expect(data.title).toBe('Audio Track');
    expect(mpv.launch).toHaveBeenCalledWith({
      url: 'https://www.youtube.com/watch?v=music',
      timestamp: undefined,
      audioOnly: true,
    });
  });
});

// ============================= play_similar ================================
describe('play_similar', () => {
  const call = (args: any) => toolHandlers.get('play_similar')!(args);

  it('returns error if nothing playing', async () => {
    vi.mocked(mpv.isPlaying).mockReturnValue(false);
    const res = await call({ limit: 10, play_now: false });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('No video is currently playing');
  });

  it('returns error if cannot get title', async () => {
    vi.mocked(mpv.isPlaying).mockReturnValue(true);
    vi.mocked(mpv.getProperty).mockRejectedValueOnce(new Error('ipc fail'));
    const res = await call({ limit: 10, play_now: false });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Cannot get current video info');
  });

  it('play_now=false: appends videos to queue', async () => {
    vi.mocked(mpv.isPlaying).mockReturnValue(true);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('Current Video');
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      entries: [
        { title: 'Similar1', url: 'https://youtube.com/s1' },
        { title: 'Similar2', url: 'https://youtube.com/s2' },
        { title: 'Current Video', url: 'https://youtube.com/cv' }, // should be filtered
      ],
    });
    vi.mocked(mpv.appendUrl).mockResolvedValue(undefined);

    const res = await call({ limit: 10, play_now: false });
    const data = parseResult(res);
    expect(data.status).toBe('queued_similar');
    expect(data.basedOn).toBe('Current Video');
    expect(data.queued).toBe(2);
    expect(mpv.appendUrl).toHaveBeenCalledTimes(2);
  });

  it('play_now=true: writes playlist and launches', async () => {
    vi.mocked(mpv.isPlaying).mockReturnValue(true);
    vi.mocked(mpv.getProperty)
      .mockResolvedValueOnce('Current Video')   // initial title check
      .mockResolvedValueOnce('Similar1');        // after launch title check
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      entries: [
        { title: 'Similar1', url: 'https://youtube.com/s1' },
        { title: 'Similar2', url: 'https://youtube.com/s2' },
      ],
    });
    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);

    const res = await call({ limit: 10, play_now: true });
    const data = parseResult(res);
    expect(data.status).toBe('playing_similar');
    expect(data.basedOn).toBe('Current Video');
    expect(mpv.writeTempPlaylist).toHaveBeenCalledWith([
      'https://youtube.com/s1',
      'https://youtube.com/s2',
    ]);
    expect(mpv.launch).toHaveBeenCalledWith({
      playlistFile: '/tmp/test-playlist.txt',
      socketTimeoutMs: 15_000,
    });
  });
});

// ============================= Additional branch coverage tests =============

describe('play_shorts (additional branches)', () => {
  const call = (args: any) => toolHandlers.get('play_shorts')!(args);

  it('returns error when fetchFeed throws for channel source', async () => {
    vi.mocked(fetchFeed).mockRejectedValueOnce(new Error('fetch failed'));
    const res = await call({
      source: 'channel',
      channel_url: 'https://www.youtube.com/@TestChannel',
      max_channels: 15,
      shorts_per_channel: 3,
      limit: 15,
      shuffle: false,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Error fetching shorts');
  });

  it('returns error when fetchFeed throws for subscriptions source', async () => {
    vi.mocked(fetchFeed).mockRejectedValueOnce(new Error('sub fetch failed'));
    const res = await call({
      source: 'subscriptions',
      max_channels: 15,
      shorts_per_channel: 3,
      limit: 15,
      shuffle: false,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Error fetching shorts');
  });

  it('returns error when mpv.launch throws after fetching shorts', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      entries: [{ url: 'https://youtube.com/shorts/1' }],
    });
    vi.mocked(mpv.launch).mockRejectedValueOnce(new Error('mpv crash'));
    const res = await call({
      source: 'channel',
      channel_url: 'https://www.youtube.com/@TestChannel',
      max_channels: 15,
      shorts_per_channel: 3,
      limit: 15,
      shuffle: false,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('mpv failed to start');
  });
});

describe('queue_video (additional branches)', () => {
  const call = (args: any) => toolHandlers.get('queue_video')!(args);

  it('returns error when launch throws and nothing is playing', async () => {
    vi.mocked(mpv.isPlaying).mockReturnValue(false);
    vi.mocked(mpv.launch).mockRejectedValueOnce(new Error('launch fail'));
    const res = await call({ url: 'https://www.youtube.com/watch?v=abc' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('mpv failed to start');
  });

  it('returns error when appendUrl throws while playing', async () => {
    vi.mocked(mpv.isPlaying).mockReturnValue(true);
    vi.mocked(mpv.appendUrl).mockRejectedValueOnce(new Error('append fail'));
    const res = await call({ url: 'https://www.youtube.com/watch?v=def' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('append fail');
  });
});

describe('play_audio (additional branches)', () => {
  const call = (args: any) => toolHandlers.get('play_audio')!(args);

  it('returns error when mpv.launch throws', async () => {
    vi.mocked(mpv.launch).mockRejectedValueOnce(new Error('audio fail'));
    const res = await call({ url: 'https://www.youtube.com/watch?v=music' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('mpv failed to start');
  });
});

describe('play_similar (additional branches)', () => {
  const call = (args: any) => toolHandlers.get('play_similar')!(args);

  it('returns error when currentTitle is empty string', async () => {
    vi.mocked(mpv.isPlaying).mockReturnValue(true);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('');
    const res = await call({ limit: 10, play_now: false });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Cannot determine current video title');
  });

  it('returns "No similar videos found." when all results filtered out', async () => {
    vi.mocked(mpv.isPlaying).mockReturnValue(true);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('Current Video');
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      entries: [{ title: 'Current Video', url: 'https://youtube.com/cv' }],
    });
    const res = await call({ limit: 10, play_now: false });
    const data = parseResult(res);
    expect(data).toBe('No similar videos found.');
  });

  it('returns error when fetchFeed throws during search', async () => {
    vi.mocked(mpv.isPlaying).mockReturnValue(true);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('Current Video');
    vi.mocked(fetchFeed).mockRejectedValueOnce(new Error('search fail'));
    const res = await call({ limit: 10, play_now: false });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('search fail');
  });
});

describe('get_subscription_shorts (additional branches)', () => {
  const call = (args: any) => toolHandlers.get('get_subscription_shorts')!(args);

  it('handles Promise.allSettled rejected results gracefully', async () => {
    // First call returns channels, one with no URL
    vi.mocked(fetchFeed)
      .mockResolvedValueOnce({
        entries: [
          { channel: 'Ch1', channel_url: 'https://www.youtube.com/@Ch1', title: 'Channel 1' },
          { channel: 'Ch2', channel_url: 'https://www.youtube.com/@Ch2', title: 'Channel 2' },
        ],
      })
      // Ch1 shorts fetch succeeds
      .mockResolvedValueOnce({
        entries: [
          { title: 'Short1', url: 'https://youtube.com/shorts/1', duration: 15, view_count: 50, upload_date: '20240301', channel: 'Ch1' },
        ],
      })
      // Ch2 shorts fetch fails
      .mockRejectedValueOnce(new Error('channel unavailable'));

    const res = await call({ max_channels: 15, shorts_per_channel: 3 });
    const data = parseResult(res);
    // Should still return the successful results
    expect(data.count).toBeGreaterThanOrEqual(1);
    expect(data.channels_sampled).toContain('Ch1');
  });

  it('handles channels with no channel_url (uses ch.url fallback)', async () => {
    vi.mocked(fetchFeed)
      .mockResolvedValueOnce({
        entries: [
          { channel: 'Ch1', title: 'Channel 1', url: 'https://www.youtube.com/@Ch1' },
        ],
      })
      .mockResolvedValueOnce({
        entries: [
          { title: 'Short1', url: 'https://youtube.com/shorts/1', duration: 15, view_count: 50, upload_date: '20240301', channel: 'Ch1' },
        ],
      });

    const res = await call({ max_channels: 15, shorts_per_channel: 3 });
    const data = parseResult(res);
    expect(data.count).toBe(1);
  });

  it('returns error when outer fetchFeed throws', async () => {
    vi.mocked(fetchFeed).mockRejectedValueOnce(new Error('outer fail'));
    const res = await call({ max_channels: 15, shorts_per_channel: 3 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('outer fail');
  });
});

describe('play_tiktok_user (additional branches)', () => {
  const call = (args: any) => toolHandlers.get('play_tiktok_user')!(args);

  it('returns url as title when getProperty throws after launch', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      entries: [{ url: 'https://tiktok.com/v1' }],
    });
    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockRejectedValueOnce(new Error('loading'));

    const res = await call({ username: 'creator', limit: 15, shuffle: false });
    const data = parseResult(res);
    expect(data.status).toBe('playing_tiktok');
    expect(data.title).toBe('@creator');
  });
});

describe('play_shorts (auto-refill callback)', () => {
  const call = (args: any) => toolHandlers.get('play_shorts')!(args);

  it('invokes the auto-refill callback passed to startAutoRefill', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      entries: [{ url: 'https://youtube.com/shorts/1' }, { url: 'https://youtube.com/shorts/2' }],
    });
    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('Short Title');

    // Capture the callback
    let refillCallback: ((offset: number, batch: number) => Promise<string[]>) | null = null;
    vi.mocked(mpv.startAutoRefill).mockImplementation((_len: number, cb: any) => {
      refillCallback = cb;
    });

    await call({
      source: 'channel',
      channel_url: 'https://www.youtube.com/@TestChannel',
      max_channels: 15,
      shorts_per_channel: 3,
      limit: 15,
      shuffle: false,
    });

    expect(refillCallback).not.toBeNull();

    // Now invoke the callback to cover lines 431-432
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      entries: [{ url: 'https://youtube.com/shorts/3' }, { url: null }],
    });
    const urls = await refillCallback!(2, 5);
    expect(urls).toEqual(['https://youtube.com/shorts/3']);
  });
});

describe('play_tiktok_user (auto-refill callback)', () => {
  const call = (args: any) => toolHandlers.get('play_tiktok_user')!(args);

  it('invokes the auto-refill callback passed to startAutoRefill', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      entries: [{ url: 'https://tiktok.com/v1' }],
    });
    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('TikTok Title');

    let refillCallback: ((offset: number, batch: number) => Promise<string[]>) | null = null;
    vi.mocked(mpv.startAutoRefill).mockImplementation((_len: number, cb: any) => {
      refillCallback = cb;
    });

    await call({ username: 'creator', limit: 15, shuffle: false });
    expect(refillCallback).not.toBeNull();

    // Invoke the callback to cover lines 502-503
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      entries: [{ url: 'https://tiktok.com/v2' }, { url: '' }],
    });
    const urls = await refillCallback!(1, 10);
    expect(urls).toEqual(['https://tiktok.com/v2']);
  });
});

describe('error handling with non-Error objects', () => {
  it('pause_video handles non-Error thrown value', async () => {
    vi.mocked(mpv.command).mockRejectedValueOnce('string error');
    const res = await toolHandlers.get('pause_video')!({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('string error');
  });

  it('seek_video handles non-Error thrown value', async () => {
    vi.mocked(mpv.command).mockRejectedValueOnce(42);
    const res = await toolHandlers.get('seek_video')!({ seconds: 10 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('42');
  });

  it('next_video handles non-Error thrown value', async () => {
    vi.mocked(mpv.command).mockRejectedValueOnce('next fail');
    const res = await toolHandlers.get('next_video')!({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('next fail');
  });

  it('prev_video handles non-Error thrown value', async () => {
    vi.mocked(mpv.command).mockRejectedValueOnce('prev fail');
    const res = await toolHandlers.get('prev_video')!({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('prev fail');
  });

  it('get_status handles non-Error thrown value', async () => {
    vi.mocked(mpv.getProperty).mockRejectedValueOnce('status fail');
    const res = await toolHandlers.get('get_status')!({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('status fail');
  });

  it('get_youtube_feed handles non-Error thrown value', async () => {
    vi.mocked(fetchFeed).mockRejectedValueOnce('feed fail');
    const res = await toolHandlers.get('get_youtube_feed')!({ feed: 'subscriptions', limit: 15 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('feed fail');
  });

  it('search_youtube handles non-Error thrown value', async () => {
    vi.mocked(fetchFeed).mockRejectedValueOnce('search fail');
    const res = await toolHandlers.get('search_youtube')!({ query: 'test', limit: 10 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('search fail');
  });

  it('get_video_info handles non-Error thrown value', async () => {
    vi.mocked(fetchVideoInfo).mockRejectedValueOnce('info fail');
    const res = await toolHandlers.get('get_video_info')!({ url: 'https://www.youtube.com/watch?v=abc' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('info fail');
  });

  it('get_subscribed_channels handles non-Error thrown value', async () => {
    vi.mocked(fetchFeed).mockRejectedValueOnce('sub fail');
    const res = await toolHandlers.get('get_subscribed_channels')!({ limit: 30 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('sub fail');
  });

  it('get_channel_videos handles non-Error thrown value', async () => {
    vi.mocked(fetchFeed).mockRejectedValueOnce('channel fail');
    const res = await toolHandlers.get('get_channel_videos')!({ channel_url: 'https://www.youtube.com/@Test', limit: 15 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('channel fail');
  });

  it('get_channel_shorts handles non-Error thrown value', async () => {
    vi.mocked(fetchFeed).mockRejectedValueOnce('shorts fail');
    const res = await toolHandlers.get('get_channel_shorts')!({ channel_url: 'https://www.youtube.com/@Test', limit: 15 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('shorts fail');
  });

  it('get_subscription_shorts handles non-Error thrown value', async () => {
    vi.mocked(fetchFeed).mockRejectedValueOnce('sub shorts fail');
    const res = await toolHandlers.get('get_subscription_shorts')!({ max_channels: 15, shorts_per_channel: 3 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('sub shorts fail');
  });

  it('get_tiktok_user_videos handles non-Error thrown value', async () => {
    vi.mocked(fetchFeed).mockRejectedValueOnce('tiktok fail');
    const res = await toolHandlers.get('get_tiktok_user_videos')!({ username: 'test', limit: 15 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('tiktok fail');
  });

  it('play_tiktok_user handles non-Error thrown value', async () => {
    vi.mocked(fetchFeed).mockRejectedValueOnce('tiktok play fail');
    const res = await toolHandlers.get('play_tiktok_user')!({ username: 'test', limit: 15, shuffle: false });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('tiktok play fail');
  });

  it('queue_video appendUrl handles non-Error thrown value', async () => {
    vi.mocked(mpv.isPlaying).mockReturnValue(true);
    vi.mocked(mpv.appendUrl).mockRejectedValueOnce('queue fail');
    const res = await toolHandlers.get('queue_video')!({ url: 'https://www.youtube.com/watch?v=abc' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('queue fail');
  });

  it('play_similar handles non-Error thrown value in search', async () => {
    vi.mocked(mpv.isPlaying).mockReturnValue(true);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('Current');
    vi.mocked(fetchFeed).mockRejectedValueOnce('similar fail');
    const res = await toolHandlers.get('play_similar')!({ limit: 10, play_now: false });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('similar fail');
  });

  it('play_shorts handles non-Error thrown value in fetch', async () => {
    vi.mocked(fetchFeed).mockRejectedValueOnce('shorts fetch fail');
    const res = await toolHandlers.get('play_shorts')!({
      source: 'channel',
      channel_url: 'https://www.youtube.com/@Test',
      max_channels: 15, shorts_per_channel: 3, limit: 15, shuffle: false,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('shorts fetch fail');
  });
});

describe('checkDeps early returns', () => {
  it('play_playlist returns dep error', async () => {
    vi.mocked(checkDeps).mockReturnValue('yt-dlp missing');
    const res = await toolHandlers.get('play_playlist')!({ url: 'https://www.youtube.com/playlist?list=PLabc', shuffle: false });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('yt-dlp missing');
  });

  it('get_youtube_feed returns dep error', async () => {
    vi.mocked(checkDeps).mockReturnValue('deps missing');
    const res = await toolHandlers.get('get_youtube_feed')!({ feed: 'subscriptions', limit: 15 });
    expect(res.isError).toBe(true);
  });

  it('search_youtube returns dep error', async () => {
    vi.mocked(checkDeps).mockReturnValue('deps missing');
    const res = await toolHandlers.get('search_youtube')!({ query: 'test', limit: 10 });
    expect(res.isError).toBe(true);
  });

  it('get_video_info returns dep error', async () => {
    vi.mocked(checkDeps).mockReturnValue('deps missing');
    const res = await toolHandlers.get('get_video_info')!({ url: 'https://www.youtube.com/watch?v=abc' });
    expect(res.isError).toBe(true);
  });

  it('get_subscribed_channels returns dep error', async () => {
    vi.mocked(checkDeps).mockReturnValue('deps missing');
    const res = await toolHandlers.get('get_subscribed_channels')!({ limit: 30 });
    expect(res.isError).toBe(true);
  });

  it('get_channel_videos returns dep error', async () => {
    vi.mocked(checkDeps).mockReturnValue('deps missing');
    const res = await toolHandlers.get('get_channel_videos')!({ channel_url: 'https://www.youtube.com/@Test', limit: 15 });
    expect(res.isError).toBe(true);
  });

  it('get_channel_shorts returns dep error', async () => {
    vi.mocked(checkDeps).mockReturnValue('deps missing');
    const res = await toolHandlers.get('get_channel_shorts')!({ channel_url: 'https://www.youtube.com/@Test', limit: 15 });
    expect(res.isError).toBe(true);
  });

  it('get_subscription_shorts returns dep error', async () => {
    vi.mocked(checkDeps).mockReturnValue('deps missing');
    const res = await toolHandlers.get('get_subscription_shorts')!({ max_channels: 15, shorts_per_channel: 3 });
    expect(res.isError).toBe(true);
  });

  it('play_shorts returns dep error', async () => {
    vi.mocked(checkDeps).mockReturnValue('deps missing');
    const res = await toolHandlers.get('play_shorts')!({
      source: 'channel', channel_url: 'https://www.youtube.com/@Test',
      max_channels: 15, shorts_per_channel: 3, limit: 15, shuffle: false,
    });
    expect(res.isError).toBe(true);
  });

  it('get_tiktok_user_videos returns dep error', async () => {
    vi.mocked(checkDeps).mockReturnValue('deps missing');
    const res = await toolHandlers.get('get_tiktok_user_videos')!({ username: 'test', limit: 15 });
    expect(res.isError).toBe(true);
  });

  it('play_tiktok_user returns dep error', async () => {
    vi.mocked(checkDeps).mockReturnValue('deps missing');
    const res = await toolHandlers.get('play_tiktok_user')!({ username: 'test', limit: 15, shuffle: false });
    expect(res.isError).toBe(true);
  });

  it('queue_video returns dep error', async () => {
    vi.mocked(checkDeps).mockReturnValue('deps missing');
    const res = await toolHandlers.get('queue_video')!({ url: 'https://www.youtube.com/watch?v=abc' });
    expect(res.isError).toBe(true);
  });

  it('play_audio returns dep error', async () => {
    vi.mocked(checkDeps).mockReturnValue('deps missing');
    const res = await toolHandlers.get('play_audio')!({ url: 'https://www.youtube.com/watch?v=abc' });
    expect(res.isError).toBe(true);
  });

  it('play_similar returns dep error', async () => {
    vi.mocked(checkDeps).mockReturnValue('deps missing');
    const res = await toolHandlers.get('play_similar')!({ limit: 10, play_now: false });
    expect(res.isError).toBe(true);
  });
});

describe('getProperty fallback branches', () => {
  it('play_video: getProperty returns empty string, falls back to url', async () => {
    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('');
    const res = await toolHandlers.get('play_video')!({ url: 'https://www.youtube.com/watch?v=abc', audio_only: false });
    const data = parseResult(res);
    expect(data.title).toBe('https://www.youtube.com/watch?v=abc');
  });

  it('play_playlist: getProperty returns empty string for title', async () => {
    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty)
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(5);
    const res = await toolHandlers.get('play_playlist')!({ url: 'https://www.youtube.com/playlist?list=PLabc', shuffle: false });
    const data = parseResult(res);
    expect(data.title).toBe('https://www.youtube.com/playlist?list=PLabc');
  });

  it('play_shorts: getProperty returns empty string, falls back to default', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      entries: [{ url: 'https://youtube.com/shorts/1' }],
    });
    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('');
    const res = await toolHandlers.get('play_shorts')!({
      source: 'channel',
      channel_url: 'https://www.youtube.com/@TestChannel',
      max_channels: 15, shorts_per_channel: 3, limit: 15, shuffle: false,
    });
    const data = parseResult(res);
    expect(data.title).toBe('Shorts playlist');
  });

  it('play_audio: getProperty returns empty string, falls back to url', async () => {
    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('');
    const res = await toolHandlers.get('play_audio')!({ url: 'https://www.youtube.com/watch?v=music' });
    const data = parseResult(res);
    expect(data.title).toBe('https://www.youtube.com/watch?v=music');
  });

  it('play_tiktok_user: getProperty returns empty string, falls back to handle', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      entries: [{ url: 'https://tiktok.com/v1' }],
    });
    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('');
    const res = await toolHandlers.get('play_tiktok_user')!({ username: 'creator', limit: 15, shuffle: false });
    const data = parseResult(res);
    expect(data.title).toBe('@creator');
  });

  it('play_similar play_now=true: getProperty returns empty string after launch', async () => {
    vi.mocked(mpv.isPlaying).mockReturnValue(true);
    vi.mocked(mpv.getProperty)
      .mockResolvedValueOnce('Current Video')
      .mockResolvedValueOnce('');
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      entries: [{ title: 'Similar1', url: 'https://youtube.com/s1' }],
    });
    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    const res = await toolHandlers.get('play_similar')!({ limit: 10, play_now: true });
    const data = parseResult(res);
    expect(data.title).toBe('Similar videos');
  });

  it('queue_video: getProperty returns empty string when not playing, falls back to url', async () => {
    vi.mocked(mpv.isPlaying).mockReturnValue(false);
    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('');
    const res = await toolHandlers.get('queue_video')!({ url: 'https://www.youtube.com/watch?v=abc' });
    const data = parseResult(res);
    expect(data.title).toBe('https://www.youtube.com/watch?v=abc');
  });
});

describe('play_shorts URL validation for channel source', () => {
  it('returns error for invalid channel_url', async () => {
    const res = await toolHandlers.get('play_shorts')!({
      source: 'channel',
      channel_url: 'https://example.com/@Test',
      max_channels: 15, shorts_per_channel: 3, limit: 15, shuffle: false,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('YouTube');
  });
});

describe('play_audio with timestamp', () => {
  it('includes startedAt when timestamp is provided', async () => {
    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('Audio Track');
    const res = await toolHandlers.get('play_audio')!({ url: 'https://www.youtube.com/watch?v=music', timestamp: 60 });
    const data = parseResult(res);
    expect(data.startedAt).toBe('60s');
  });

  it('omits startedAt when no timestamp', async () => {
    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('Audio Track');
    const res = await toolHandlers.get('play_audio')!({ url: 'https://www.youtube.com/watch?v=music' });
    const data = parseResult(res);
    expect(data.startedAt).toBeUndefined();
  });
});

describe('get_channel_videos error handling', () => {
  it('returns error when fetchFeed throws', async () => {
    vi.mocked(fetchFeed).mockRejectedValueOnce(new Error('channel error'));
    const res = await toolHandlers.get('get_channel_videos')!({ channel_url: 'https://www.youtube.com/@Test', limit: 15 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('channel error');
  });

  it('returns dep error for invalid URL', async () => {
    const res = await toolHandlers.get('get_channel_videos')!({ channel_url: 'https://example.com/@Test', limit: 15 });
    expect(res.isError).toBe(true);
  });
});

describe('get_channel_shorts error handling', () => {
  it('returns error when fetchFeed throws', async () => {
    vi.mocked(fetchFeed).mockRejectedValueOnce(new Error('shorts error'));
    const res = await toolHandlers.get('get_channel_shorts')!({ channel_url: 'https://www.youtube.com/@Test', limit: 15 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('shorts error');
  });
});

describe('get_subscribed_channels error handling', () => {
  it('returns error when fetchFeed throws', async () => {
    vi.mocked(fetchFeed).mockRejectedValueOnce(new Error('subs error'));
    const res = await toolHandlers.get('get_subscribed_channels')!({ limit: 30 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('subs error');
  });
});

describe('search_youtube error handling', () => {
  it('returns error when fetchFeed throws', async () => {
    vi.mocked(fetchFeed).mockRejectedValueOnce(new Error('search error'));
    const res = await toolHandlers.get('search_youtube')!({ query: 'test', limit: 10 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('search error');
  });
});

describe('get_video_info error handling', () => {
  it('returns error when fetchVideoInfo throws', async () => {
    vi.mocked(fetchVideoInfo).mockRejectedValueOnce(new Error('info error'));
    const res = await toolHandlers.get('get_video_info')!({ url: 'https://www.youtube.com/watch?v=abc' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('info error');
  });
});

describe('play_shorts subscriptions with edge-case channels', () => {
  const call = (args: any) => toolHandlers.get('play_shorts')!(args);

  it('handles channels with no channel_url (falls back to ch.url) and channel with no url at all', async () => {
    vi.mocked(fetchFeed)
      // fetch subscribed channels - one has channel_url, one only has url, one has neither
      .mockResolvedValueOnce({
        entries: [
          { channel: 'Ch1', title: 'Ch1', url: 'https://www.youtube.com/@Ch1' },
          { channel: 'Ch2', title: 'Ch2' },  // no url at all
        ],
      })
      // Ch1 shorts (from url fallback)
      .mockResolvedValueOnce({
        entries: [{ url: 'https://youtube.com/shorts/1', upload_date: '20240301' }],
      });
    // Ch2 returns [] immediately since no chUrl

    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('Sub Short');

    const res = await call({
      source: 'subscriptions',
      max_channels: 15,
      shorts_per_channel: 3,
      limit: 15,
      shuffle: false,
    });
    const data = parseResult(res);
    expect(data.status).toBe('playing_shorts');
  });

  it('handles entries with missing upload_date in sort', async () => {
    vi.mocked(fetchFeed)
      .mockResolvedValueOnce({
        entries: [
          { channel: 'Ch1', channel_url: 'https://www.youtube.com/@Ch1', title: 'Ch1' },
        ],
      })
      .mockResolvedValueOnce({
        entries: [
          { url: 'https://youtube.com/shorts/1', upload_date: undefined },
          { url: 'https://youtube.com/shorts/2', upload_date: '20240301' },
        ],
      });

    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('Short');

    const res = await call({
      source: 'subscriptions',
      max_channels: 15,
      shorts_per_channel: 3,
      limit: 15,
      shuffle: false,
    });
    const data = parseResult(res);
    expect(data.status).toBe('playing_shorts');
  });

  it('handles fetchFeed returning undefined entries', async () => {
    vi.mocked(fetchFeed)
      .mockResolvedValueOnce({
        entries: [
          { channel: 'Ch1', channel_url: 'https://www.youtube.com/@Ch1', title: 'Ch1' },
        ],
      })
      .mockResolvedValueOnce({} as any);  // no entries property

    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('Short');

    // No shorts found because entries is undefined
    const res = await call({
      source: 'subscriptions',
      max_channels: 15,
      shorts_per_channel: 3,
      limit: 15,
      shuffle: false,
    });
    const data = parseResult(res);
    expect(data).toBe('No shorts found.');
  });
});

describe('get_subscription_shorts edge cases', () => {
  const call = (args: any) => toolHandlers.get('get_subscription_shorts')!(args);

  it('handles channels without channel field (uses title fallback)', async () => {
    vi.mocked(fetchFeed)
      .mockResolvedValueOnce({
        entries: [
          { title: 'Channel Title Only', channel_url: 'https://www.youtube.com/@Ch1' },
        ],
      })
      .mockResolvedValueOnce({
        entries: [
          { title: 'Short1', url: 'https://youtube.com/shorts/1', duration: 15, view_count: 50, upload_date: '20240301' },
        ],
      });
    const res = await call({ max_channels: 15, shorts_per_channel: 3 });
    const data = parseResult(res);
    expect(data.channels_sampled).toContain('Channel Title Only');
  });

  it('handles channel with no channel_url (uses ch.url)', async () => {
    vi.mocked(fetchFeed)
      .mockResolvedValueOnce({
        entries: [
          { channel: 'Ch1', title: 'Ch1', url: 'https://www.youtube.com/@Ch1' },
        ],
      })
      .mockResolvedValueOnce({
        entries: [
          { title: 'Short1', url: 'https://youtube.com/shorts/1', duration: 15, view_count: 50, upload_date: '20240301' },
        ],
      });
    const res = await call({ max_channels: 15, shorts_per_channel: 3 });
    const data = parseResult(res);
    expect(data.count).toBe(1);
  });

  it('handles channel with no URL at all', async () => {
    vi.mocked(fetchFeed)
      .mockResolvedValueOnce({
        entries: [
          { channel: 'Ch1', title: 'Ch1' },  // no channel_url, no url
        ],
      });
    const res = await call({ max_channels: 15, shorts_per_channel: 3 });
    const data = parseResult(res);
    expect(data.count).toBe(0);
  });

  it('handles entries with missing upload_date in sort', async () => {
    vi.mocked(fetchFeed)
      .mockResolvedValueOnce({
        entries: [
          { channel: 'Ch1', channel_url: 'https://www.youtube.com/@Ch1', title: 'Ch1' },
        ],
      })
      .mockResolvedValueOnce({
        entries: [
          { title: 'S1', url: 'https://youtube.com/shorts/1', duration: 15, view_count: 50, upload_date: undefined },
          { title: 'S2', url: 'https://youtube.com/shorts/2', duration: 15, view_count: 50, upload_date: '20240301' },
        ],
      });
    const res = await call({ max_channels: 15, shorts_per_channel: 3 });
    const data = parseResult(res);
    expect(data.count).toBe(2);
  });

  it('handles fetchFeed returning undefined entries for shorts', async () => {
    vi.mocked(fetchFeed)
      .mockResolvedValueOnce({
        entries: [
          { channel: 'Ch1', channel_url: 'https://www.youtube.com/@Ch1', title: 'Ch1' },
        ],
      })
      .mockResolvedValueOnce({} as any);
    const res = await call({ max_channels: 15, shorts_per_channel: 3 });
    const data = parseResult(res);
    expect(data.count).toBe(0);
  });
});

describe('fetchFeed returning undefined entries', () => {
  it('get_youtube_feed handles undefined entries', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({} as any);
    const res = await toolHandlers.get('get_youtube_feed')!({ feed: 'subscriptions', limit: 15 });
    const data = parseResult(res);
    expect(data.count).toBe(0);
  });

  it('search_youtube handles undefined entries', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({} as any);
    const res = await toolHandlers.get('search_youtube')!({ query: 'test', limit: 10 });
    const data = parseResult(res);
    expect(data.count).toBe(0);
  });

  it('get_subscribed_channels handles undefined entries', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({} as any);
    const res = await toolHandlers.get('get_subscribed_channels')!({ limit: 30 });
    const data = parseResult(res);
    expect(data.count).toBe(0);
  });

  it('get_channel_videos handles undefined entries', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({} as any);
    const res = await toolHandlers.get('get_channel_videos')!({ channel_url: 'https://www.youtube.com/@Test', limit: 15 });
    const data = parseResult(res);
    expect(data.count).toBe(0);
  });

  it('get_channel_shorts handles undefined entries', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({} as any);
    const res = await toolHandlers.get('get_channel_shorts')!({ channel_url: 'https://www.youtube.com/@Test', limit: 15 });
    const data = parseResult(res);
    expect(data.count).toBe(0);
  });

  it('play_shorts channel source handles undefined entries', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({} as any);
    const res = await toolHandlers.get('play_shorts')!({
      source: 'channel',
      channel_url: 'https://www.youtube.com/@Test',
      max_channels: 15, shorts_per_channel: 3, limit: 15, shuffle: false,
    });
    const data = parseResult(res);
    expect(data).toBe('No shorts found.');
  });

  it('get_tiktok_user_videos handles undefined entries', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({} as any);
    const res = await toolHandlers.get('get_tiktok_user_videos')!({ username: 'test', limit: 15 });
    const data = parseResult(res);
    expect(data.count).toBe(0);
  });

  it('play_tiktok_user handles undefined entries (no videos found)', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({} as any);
    const res = await toolHandlers.get('play_tiktok_user')!({ username: 'test', limit: 15, shuffle: false });
    const data = parseResult(res);
    expect(data).toBe('No videos found.');
  });

  it('play_similar handles undefined entries in search results', async () => {
    vi.mocked(mpv.isPlaying).mockReturnValue(true);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('Current Video');
    vi.mocked(fetchFeed).mockResolvedValueOnce({} as any);
    const res = await toolHandlers.get('play_similar')!({ limit: 10, play_now: false });
    const data = parseResult(res);
    expect(data).toBe('No similar videos found.');
  });
});

describe('play_similar with videos having no url', () => {
  it('play_now=false: skips videos with no url', async () => {
    vi.mocked(mpv.isPlaying).mockReturnValue(true);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('Current Video');
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      entries: [
        { title: 'NoUrl', url: '' },
        { title: 'HasUrl', url: 'https://youtube.com/v1' },
      ],
    });
    vi.mocked(mpv.appendUrl).mockResolvedValue(undefined);
    const res = await toolHandlers.get('play_similar')!({ limit: 10, play_now: false });
    const data = parseResult(res);
    expect(data.queued).toBe(1);
  });
});

describe('pause_video with Error instance', () => {
  it('handles Error instance in catch', async () => {
    vi.mocked(mpv.command).mockRejectedValueOnce(new Error('pause error'));
    const res = await toolHandlers.get('pause_video')!({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('pause error');
  });
});

describe('prev_video error handling', () => {
  it('returns error when command throws Error', async () => {
    vi.mocked(mpv.command).mockRejectedValueOnce(new Error('prev error'));
    const res = await toolHandlers.get('prev_video')!({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('prev error');
  });
});

describe('get_status error handling', () => {
  it('returns error when getProperty throws Error', async () => {
    vi.mocked(mpv.getProperty).mockRejectedValueOnce(new Error('status error'));
    const res = await toolHandlers.get('get_status')!({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('status error');
  });
});

describe('fetchSubscriptionShortUrls edge cases via play_shorts', () => {
  const call = (args: any) => toolHandlers.get('play_shorts')!(args);

  it('handles undefined entries from subscriptions feed', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({} as any); // no entries property
    const res = await call({
      source: 'subscriptions',
      max_channels: 15, shorts_per_channel: 3, limit: 15, shuffle: false,
    });
    const data = parseResult(res);
    expect(data).toBe('No shorts found.');
  });

  it('handles rejected promises in Promise.allSettled and missing upload_date', async () => {
    vi.mocked(fetchFeed)
      .mockResolvedValueOnce({
        entries: [
          { title: 'Ch1', url: 'https://www.youtube.com/@Ch1' },  // no channel field (uses title)
          { title: 'Ch2', channel_url: 'https://www.youtube.com/@Ch2' },
        ],
      })
      // Ch1 shorts succeed with missing upload_date
      .mockResolvedValueOnce({
        entries: [
          { url: 'https://youtube.com/shorts/1', upload_date: undefined },
        ],
      })
      // Ch2 shorts fail
      .mockRejectedValueOnce(new Error('channel unavailable'));

    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('Short');

    const res = await call({
      source: 'subscriptions',
      max_channels: 15, shorts_per_channel: 3, limit: 15, shuffle: false,
    });
    const data = parseResult(res);
    expect(data.status).toBe('playing_shorts');
  });
});

describe('play_shorts auto-refill with undefined entries', () => {
  it('handles fetchFeed returning no entries in auto-refill callback', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      entries: [{ url: 'https://youtube.com/shorts/1' }],
    });
    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('Short');

    let refillCallback: any = null;
    vi.mocked(mpv.startAutoRefill).mockImplementation((_len: number, cb: any) => {
      refillCallback = cb;
    });

    await toolHandlers.get('play_shorts')!({
      source: 'channel',
      channel_url: 'https://www.youtube.com/@Test',
      max_channels: 15, shorts_per_channel: 3, limit: 15, shuffle: false,
    });

    // Invoke callback with fetchFeed returning no entries
    vi.mocked(fetchFeed).mockResolvedValueOnce({} as any);
    const urls = await refillCallback!(1, 5);
    expect(urls).toEqual([]);
  });
});

describe('play_tiktok_user auto-refill with undefined entries', () => {
  it('handles fetchFeed returning no entries in auto-refill callback', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      entries: [{ url: 'https://tiktok.com/v1' }],
    });
    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('TikTok');

    let refillCallback: any = null;
    vi.mocked(mpv.startAutoRefill).mockImplementation((_len: number, cb: any) => {
      refillCallback = cb;
    });

    await toolHandlers.get('play_tiktok_user')!({ username: 'test', limit: 15, shuffle: false });

    vi.mocked(fetchFeed).mockResolvedValueOnce({} as any);
    const urls = await refillCallback!(1, 5);
    expect(urls).toEqual([]);
  });
});

describe('play_audio invalid URL', () => {
  it('returns error for non-YouTube/TikTok URL', async () => {
    const res = await toolHandlers.get('play_audio')!({ url: 'https://example.com/audio' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('YouTube or TikTok');
  });
});

describe('get_tiktok_user_videos with Error instance', () => {
  it('handles Error instance in catch', async () => {
    vi.mocked(fetchFeed).mockRejectedValueOnce(new Error('tiktok error'));
    const res = await toolHandlers.get('get_tiktok_user_videos')!({ username: 'test', limit: 15 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('tiktok error');
  });
});

describe('play_tiktok_user with @ prefix', () => {
  it('does not double-prepend @ when username starts with @', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({ entries: [] });
    const res = await toolHandlers.get('play_tiktok_user')!({ username: '@creator', limit: 15, shuffle: false });
    expect(fetchFeed).toHaveBeenCalledWith('https://www.tiktok.com/@creator', 15);
  });
});

describe('get_subscription_shorts with undefined entries from subs feed', () => {
  it('handles undefined entries from the subscriptions feed', async () => {
    vi.mocked(fetchFeed).mockResolvedValueOnce({} as any);
    const res = await toolHandlers.get('get_subscription_shorts')!({ max_channels: 15, shorts_per_channel: 3 });
    const data = parseResult(res);
    expect(data).toBe('No subscribed channels found.');
  });

  it('handles shorts with missing upload_date in sort', async () => {
    vi.mocked(fetchFeed)
      .mockResolvedValueOnce({
        entries: [
          { title: 'Ch1', channel_url: 'https://www.youtube.com/@Ch1' },
        ],
      })
      .mockResolvedValueOnce({
        entries: [
          { title: 'S1', url: 'https://youtube.com/shorts/1', duration: 15, view_count: 50 },
          { title: 'S2', url: 'https://youtube.com/shorts/2', duration: 15, view_count: 50, upload_date: '20240301' },
        ],
      });
    const res = await toolHandlers.get('get_subscription_shorts')!({ max_channels: 15, shorts_per_channel: 3 });
    const data = parseResult(res);
    expect(data.count).toBe(2);
  });
});

describe('sort with both items missing upload_date', () => {
  it('play_shorts subscriptions: both items missing upload_date triggers both a and b fallback', async () => {
    vi.mocked(fetchFeed)
      .mockResolvedValueOnce({
        entries: [
          { channel: 'Ch1', channel_url: 'https://www.youtube.com/@Ch1', title: 'Ch1' },
        ],
      })
      .mockResolvedValueOnce({
        entries: [
          { url: 'https://youtube.com/shorts/1', upload_date: undefined },
          { url: 'https://youtube.com/shorts/2', upload_date: undefined },
          { url: 'https://youtube.com/shorts/3', upload_date: undefined },
        ],
      });

    vi.mocked(mpv.launch).mockResolvedValueOnce(undefined);
    vi.mocked(mpv.getProperty).mockResolvedValueOnce('Short');

    const res = await toolHandlers.get('play_shorts')!({
      source: 'subscriptions',
      max_channels: 15, shorts_per_channel: 3, limit: 15, shuffle: false,
    });
    const data = parseResult(res);
    expect(data.status).toBe('playing_shorts');
  });

  it('get_subscription_shorts: both items missing upload_date triggers both a and b fallback', async () => {
    vi.mocked(fetchFeed)
      .mockResolvedValueOnce({
        entries: [
          { channel: 'Ch1', channel_url: 'https://www.youtube.com/@Ch1', title: 'Ch1' },
        ],
      })
      .mockResolvedValueOnce({
        entries: [
          { title: 'S1', url: 'https://youtube.com/shorts/1', duration: 15, view_count: 50 },
          { title: 'S2', url: 'https://youtube.com/shorts/2', duration: 15, view_count: 50 },
          { title: 'S3', url: 'https://youtube.com/shorts/3', duration: 15, view_count: 50 },
        ],
      });
    const res = await toolHandlers.get('get_subscription_shorts')!({ max_channels: 15, shorts_per_channel: 3 });
    const data = parseResult(res);
    expect(data.count).toBe(3);
  });
});

// ============================= set_browser =================================
describe('set_browser', () => {
  const call = (args: any) => toolHandlers.get('set_browser')!(args);

  it('returns error for unsupported browser', async () => {
    const res = await call({ browser: 'netscape' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Unsupported browser');
  });

  it('returns success for valid browser', async () => {
    const res = await call({ browser: 'firefox' });
    const data = parseResult(res);
    expect(data.status).toBe('browser_updated');
    expect(data.browser).toBe('firefox');
  });
});

// ============================= get_browser =================================
describe('get_browser', () => {
  const call = () => toolHandlers.get('get_browser')!({});

  it('returns current browser and supported list', async () => {
    const res = await call();
    const data = parseResult(res);
    expect(data.browser).toBeDefined();
    expect(data.supported).toBeInstanceOf(Array);
    expect(data.supported).toContain('chrome');
    expect(data.supported).toContain('firefox');
  });
});
