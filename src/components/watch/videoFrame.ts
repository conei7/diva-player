/**
 * The 16:9 video frame of the watch page: as wide as the main column (no height cap, so the page
 * uses the whole window width). Full width without rounding under 640px. At least 200px tall, the
 * embedded players' minimum (YouTube: 200×200), so under 356px wide the video letterboxes in it.
 */
export const VIDEO_FRAME_CLASS = 'aspect-video min-h-50 w-full overflow-hidden rounded-card max-sm:rounded-none';
