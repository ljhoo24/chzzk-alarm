// JSON 파일 내보내기/가져오기 형식. 순수 함수.
// 구글 계정 동기화 용량을 넘거나 동기화를 쓰지 않을 때의 백업 수단.

import { isChannelId } from './chzzkUrl.js';
import { mergeSettings, normalizeChannel } from './settings.js';
import { syncableSettings } from './syncCodec.js';

export const BACKUP_FORMAT = 'chzzk-alarm-backup';
export const BACKUP_VERSION = 1;

export function buildBackup({ channels, settings, history = null, now = Date.now(), appVersion = '' }) {
  const data = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    appVersion,
    exportedAt: new Date(now).toISOString(),
    channels: Object.values(channels).map(({ ...c }) => c),
    settings: syncableSettings(settings),
  };
  if (history) data.history = history;
  return data;
}

/**
 * 파일 내용 검증·정규화. 형식이 틀리면 throw.
 * @returns {{ channels: Record<string, object>, settings: object|null, history: object[]|null }}
 */
export function parseBackup(text) {
  let data;
  try {
    data = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    throw new Error('JSON 형식이 아닙니다.');
  }
  if (data?.format !== BACKUP_FORMAT) throw new Error('치지직 라이브 알림 백업 파일이 아닙니다.');
  if (data.version > BACKUP_VERSION) throw new Error(`더 새로운 버전(v${data.version})의 백업입니다. 확장을 업데이트하세요.`);
  if (!Array.isArray(data.channels)) throw new Error('채널 목록이 없습니다.');

  const channels = {};
  for (const c of data.channels) {
    if (!c || !isChannelId(c.id)) continue;
    const id = c.id.toLowerCase();
    channels[id] = normalizeChannel(id, c);
  }
  return {
    channels,
    settings: data.settings && typeof data.settings === 'object' ? mergeSettings(data.settings) : null,
    history: Array.isArray(data.history) ? data.history : null,
  };
}
