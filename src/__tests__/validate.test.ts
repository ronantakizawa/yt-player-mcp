import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'child_process';
import {
  validateYouTubeUrl,
  validateVideoUrl,
  validateTikTokUrl,
  errorResult,
  textResult,
  stripChannelSuffix,
  getBrowser,
  setBrowser,
  checkDeps,
  FEED_URLS,
  SUPPORTED_BROWSERS,
} from '../validate.js';

const mockedExecSync = vi.mocked(execSync);

describe('validateYouTubeUrl', () => {
  it('accepts www.youtube.com', () => {
    expect(validateYouTubeUrl('https://www.youtube.com/watch?v=abc')).toBeNull();
  });

  it('accepts youtu.be', () => {
    expect(validateYouTubeUrl('https://youtu.be/abc')).toBeNull();
  });

  it('accepts m.youtube.com', () => {
    expect(validateYouTubeUrl('https://m.youtube.com/watch?v=abc')).toBeNull();
  });

  it('accepts music.youtube.com', () => {
    expect(validateYouTubeUrl('https://music.youtube.com/watch?v=abc')).toBeNull();
  });

  it('accepts youtube.com without www', () => {
    expect(validateYouTubeUrl('https://youtube.com/watch?v=abc')).toBeNull();
  });

  it('rejects tiktok.com', () => {
    const result = validateYouTubeUrl('https://www.tiktok.com/@user/video/123');
    expect(result).toContain('must be a YouTube link');
    expect(result).toContain('www.tiktok.com');
  });

  it('rejects example.com', () => {
    const result = validateYouTubeUrl('https://example.com/video');
    expect(result).toContain('must be a YouTube link');
    expect(result).toContain('example.com');
  });

  it('rejects an invalid string', () => {
    const result = validateYouTubeUrl('not-a-url');
    expect(result).toContain('Invalid URL');
    expect(result).toContain('not-a-url');
  });

  it('rejects an empty string', () => {
    const result = validateYouTubeUrl('');
    expect(result).toContain('Invalid URL');
  });
});

describe('validateVideoUrl', () => {
  it('accepts all YouTube hosts', () => {
    expect(validateVideoUrl('https://www.youtube.com/watch?v=abc')).toBeNull();
    expect(validateVideoUrl('https://youtube.com/watch?v=abc')).toBeNull();
    expect(validateVideoUrl('https://m.youtube.com/watch?v=abc')).toBeNull();
    expect(validateVideoUrl('https://youtu.be/abc')).toBeNull();
    expect(validateVideoUrl('https://music.youtube.com/watch?v=abc')).toBeNull();
  });

  it('accepts TikTok hosts', () => {
    expect(validateVideoUrl('https://www.tiktok.com/@user/video/123')).toBeNull();
    expect(validateVideoUrl('https://tiktok.com/@user/video/123')).toBeNull();
    expect(validateVideoUrl('https://vm.tiktok.com/abc')).toBeNull();
  });

  it('rejects example.com', () => {
    const result = validateVideoUrl('https://example.com/video');
    expect(result).toContain('must be a YouTube or TikTok link');
    expect(result).toContain('example.com');
  });

  it('rejects an invalid URL', () => {
    const result = validateVideoUrl('garbage');
    expect(result).toContain('Invalid URL');
    expect(result).toContain('garbage');
  });
});

describe('validateTikTokUrl', () => {
  it('accepts www.tiktok.com', () => {
    expect(validateTikTokUrl('https://www.tiktok.com/@user/video/123')).toBeNull();
  });

  it('accepts tiktok.com', () => {
    expect(validateTikTokUrl('https://tiktok.com/@user/video/123')).toBeNull();
  });

  it('accepts vm.tiktok.com', () => {
    expect(validateTikTokUrl('https://vm.tiktok.com/abc')).toBeNull();
  });

  it('rejects YouTube URLs', () => {
    const result = validateTikTokUrl('https://www.youtube.com/watch?v=abc');
    expect(result).toContain('must be a TikTok link');
    expect(result).toContain('www.youtube.com');
  });

  it('rejects an invalid URL', () => {
    const result = validateTikTokUrl('not-valid');
    expect(result).toContain('Invalid URL');
    expect(result).toContain('not-valid');
  });
});

describe('errorResult', () => {
  it('returns correct shape with isError true', () => {
    const result = errorResult('something went wrong');
    expect(result).toEqual({
      content: [{ type: 'text', text: 'something went wrong' }],
      isError: true,
    });
  });

  it('has type "text" on the content item', () => {
    const result = errorResult('err');
    expect(result.content[0].type).toBe('text');
  });
});

describe('textResult', () => {
  it('JSON-stringifies data with 2-space indent', () => {
    const data = { foo: 'bar', num: 42 };
    const result = textResult(data);
    expect(result.content[0].text).toBe(JSON.stringify(data, null, 2));
  });

  it('does not include isError', () => {
    const result = textResult({ ok: true });
    expect(result).not.toHaveProperty('isError');
  });

  it('has type "text" on the content item', () => {
    const result = textResult('hello');
    expect(result.content[0].type).toBe('text');
  });
});

describe('stripChannelSuffix', () => {
  it('strips /shorts from the end', () => {
    expect(stripChannelSuffix('https://www.youtube.com/@channel/shorts')).toBe(
      'https://www.youtube.com/@channel',
    );
  });

  it('strips /videos from the end', () => {
    expect(stripChannelSuffix('https://www.youtube.com/@channel/videos')).toBe(
      'https://www.youtube.com/@channel',
    );
  });

  it('strips trailing slash', () => {
    expect(stripChannelSuffix('https://www.youtube.com/@channel/')).toBe(
      'https://www.youtube.com/@channel',
    );
  });

  it('leaves a bare channel URL unchanged', () => {
    expect(stripChannelSuffix('https://www.youtube.com/@channel')).toBe(
      'https://www.youtube.com/@channel',
    );
  });
});

describe('getBrowser / setBrowser', () => {
  beforeEach(() => {
    // Reset to default
    setBrowser('chrome');
  });

  it('defaults to chrome', () => {
    expect(getBrowser()).toBe('chrome');
  });

  it('sets firefox and returns null on success', () => {
    const err = setBrowser('firefox');
    expect(err).toBeNull();
    expect(getBrowser()).toBe('firefox');
  });

  it('is case-insensitive', () => {
    const err = setBrowser('Safari');
    expect(err).toBeNull();
    expect(getBrowser()).toBe('safari');
  });

  it('rejects unsupported browser and returns error string', () => {
    const err = setBrowser('netscape');
    expect(err).toContain('Unsupported browser');
    expect(err).toContain('netscape');
    // Browser should remain unchanged
    expect(getBrowser()).toBe('chrome');
  });
});

describe('checkDeps', () => {
  beforeEach(() => {
    mockedExecSync.mockReset();
  });

  it('returns null when both mpv and yt-dlp exist', () => {
    mockedExecSync.mockReturnValue(Buffer.from(''));
    expect(checkDeps()).toBeNull();
    expect(mockedExecSync).toHaveBeenCalledTimes(2);
  });

  it('returns error when mpv is missing', () => {
    mockedExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('mpv')) {
        throw new Error('not found');
      }
      return Buffer.from('');
    });
    const result = checkDeps();
    expect(result).toContain('mpv is not installed');
  });

  it('returns error when yt-dlp is missing', () => {
    mockedExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('yt-dlp')) {
        throw new Error('not found');
      }
      return Buffer.from('');
    });
    const result = checkDeps();
    expect(result).toContain('yt-dlp is not installed');
  });
});

describe('FEED_URLS', () => {
  it('has exactly 4 keys', () => {
    expect(Object.keys(FEED_URLS)).toHaveLength(4);
  });

  it('contains subscriptions, liked, watch_later, and history', () => {
    expect(FEED_URLS).toHaveProperty('subscriptions');
    expect(FEED_URLS).toHaveProperty('liked');
    expect(FEED_URLS).toHaveProperty('watch_later');
    expect(FEED_URLS).toHaveProperty('history');
  });

  it('all values are YouTube URLs', () => {
    for (const url of Object.values(FEED_URLS)) {
      expect(url).toMatch(/^https:\/\/www\.youtube\.com\//);
    }
  });
});

describe('SUPPORTED_BROWSERS', () => {
  it('has 8 entries', () => {
    expect(SUPPORTED_BROWSERS).toHaveLength(8);
  });

  it('includes expected browsers', () => {
    expect(SUPPORTED_BROWSERS).toContain('chrome');
    expect(SUPPORTED_BROWSERS).toContain('firefox');
    expect(SUPPORTED_BROWSERS).toContain('brave');
    expect(SUPPORTED_BROWSERS).toContain('edge');
    expect(SUPPORTED_BROWSERS).toContain('safari');
    expect(SUPPORTED_BROWSERS).toContain('opera');
    expect(SUPPORTED_BROWSERS).toContain('chromium');
    expect(SUPPORTED_BROWSERS).toContain('vivaldi');
  });
});
