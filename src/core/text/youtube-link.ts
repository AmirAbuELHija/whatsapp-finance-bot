import { ENDPOINTS } from '../../config/constants.js';

const YOUTUBE_LINK =
  /(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:[^\s#]*&)?v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/;

/** The 11-character video id from any common YouTube link, or null. */
export function extractYouTubeId(text: string | null | undefined): string | null {
  return YOUTUBE_LINK.exec(text ?? '')?.[1] ?? null;
}

export const watchUrl = (videoId: string): string => `${ENDPOINTS.youtubeWatch}${videoId}`;
