import { describe, expect, it } from 'vitest';
import { meetingKey, meetingTitle, meetingUrl } from './meeting';

describe('meetingUrl', () => {
  it('drops the query, which holds the Zoom passcode', () => {
    expect(
      meetingUrl(
        'https://app.zoom.us/wc/86012345678/join?pwd=secret&fromPWA=1',
      ),
    ).toBe('https://app.zoom.us/wc/86012345678/join');
    expect(meetingUrl('https://meet.google.com/abc-defg-hij?authuser=0')).toBe(
      'https://meet.google.com/abc-defg-hij',
    );
  });

  it.each([undefined, '', 'not a url'])('is null for %j', (url) => {
    expect(meetingUrl(url)).toBeNull();
  });
});

describe('meetingKey', () => {
  it('is the meeting number across Zoom web client pages', () => {
    expect(meetingKey('https://app.zoom.us/wc/86012345678/join')).toBe(
      meetingKey('https://us06web.zoom.us/wc/86012345678/start'),
    );
    expect(meetingKey('https://app.zoom.us/wc/86012345678/join')).not.toBe(
      meetingKey('https://app.zoom.us/wc/86099999999/join'),
    );
  });

  it('is the address elsewhere', () => {
    expect(meetingKey('https://meet.google.com/abc-defg-hij')).toBe(
      'https://meet.google.com/abc-defg-hij',
    );
    expect(meetingKey('https://meet.google.com/abc-defg-hij')).not.toBe(
      meetingKey('https://meet.google.com/xyz-wxyz-xyz'),
    );
  });

  it('is null without a URL', () => {
    expect(meetingKey(null)).toBeNull();
  });
});

describe('meetingTitle', () => {
  it("is Meet's meeting name without the prefix", () => {
    expect(
      meetingTitle('Meet - Comfrt Tech / Outsmartly: Project Updates'),
    ).toBe('Comfrt Tech / Outsmartly: Project Updates');
    expect(meetingTitle('Meet – Standup')).toBe('Standup');
  });

  it.each([
    'Meet - abc-defg-hij',
    'Google Meet',
    'Meet',
    'Zoom',
    'Zoom Meeting',
    '',
    undefined,
  ])('is null for %j, which names no meeting', (title) => {
    expect(meetingTitle(title)).toBeNull();
  });
});
