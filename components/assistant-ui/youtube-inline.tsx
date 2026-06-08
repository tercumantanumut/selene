"use client";

import { useMemo, useState } from "react";
import { ExternalLink, PlayIcon } from "lucide-react";
import { extractYouTubeReferences } from "@/lib/youtube/extract";

/**
 * Builds the YouTube thumbnail URL for a given video ID.
 * Uses maxresdefault with fallback to hqdefault if image fails to load.
 */
const getThumbnailUrl = (videoId: string, quality: "maxres" | "hq" = "maxres") => {
  const qualityPath = quality === "maxres" ? "maxresdefault" : "hqdefault";
  return `https://img.youtube.com/vi/${videoId}/${qualityPath}.jpg`;
};

/**
 * Simple YouTube thumbnail card component.
 * Displays a clickable thumbnail that opens the video in a new tab.
 */
const YouTubeThumbnailCard = ({
  videoId,
  url,
}: {
  videoId: string;
  url: string;
}) => {
  const [imgSrc, setImgSrc] = useState(getThumbnailUrl(videoId, "maxres"));

  const handleImageError = () => {
    // Fallback to lower quality thumbnail if maxres fails
    setImgSrc(getThumbnailUrl(videoId, "hq"));
  };

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative block overflow-hidden rounded-xl border border-terminal-dark/10 bg-terminal-cream/80 shadow-sm transition-all hover:shadow-md hover:-translate-y-0.5"
    >
      {/* Thumbnail image */}
      <div className="relative aspect-video w-full overflow-hidden bg-terminal-dark/5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imgSrc}
          alt="YouTube video thumbnail"
          className="h-full w-full object-cover transition-transform group-hover:scale-105"
          loading="lazy"
          onError={handleImageError}
        />

        {/* Play button overlay */}
        <span className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 transition-opacity group-hover:opacity-100">
          <span className="flex size-12 items-center justify-center rounded-full bg-red-600 text-white shadow-lg">
            <PlayIcon className="size-5 fill-current" />
          </span>
        </span>

        {/* External link indicator */}
        <span className="absolute right-2 top-2 flex items-center gap-1 rounded bg-terminal-dark/70 px-1.5 py-0.5 text-[10px] font-mono text-terminal-cream opacity-0 transition-opacity group-hover:opacity-100">
          <ExternalLink className="size-3" />
          Open
        </span>
      </div>
    </a>
  );
};

/**
 * YouTubeInlinePreview - Displays static thumbnail cards for YouTube URLs in messages.
 *
 * Features:
 * - No API calls - uses YouTube's direct thumbnail CDN
 * - No iframes or embedded players - opens in new tab
 * - Instant loading with no side effects
 * - Minimal footprint (~60 lines)
 */
export const YouTubeInlinePreview = ({
  messageText,
}: {
  messageText: string;
}) => {
  const { urls } = useMemo(
    () => extractYouTubeReferences(messageText),
    [messageText]
  );

  // Deduplicate by video ID before the early return so hook order stays stable.
  const uniqueUrls = useMemo(() => {
    const seen = new Set<string>();
    return urls.filter((urlRef) => {
      if (seen.has(urlRef.videoId)) return false;
      seen.add(urlRef.videoId);
      return true;
    });
  }, [urls]);

  // Don't render if no YouTube URLs found
  if (uniqueUrls.length === 0) return null;

  return (
    <div className="mt-3 not-prose">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {uniqueUrls.map((urlRef) => (
          <YouTubeThumbnailCard
            key={urlRef.videoId}
            videoId={urlRef.videoId}
            url={urlRef.url}
          />
        ))}
      </div>
    </div>
  );
};
