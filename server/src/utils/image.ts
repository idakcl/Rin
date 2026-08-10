export function stripImageMetadataFromUrl(url?: string | null) {
    if (!url) {
        return undefined;
    }

    return url.split("#", 2)[0];
}

export function parseImageMetadataFromUrl(url?: string | null) {
    if (!url) {
        return {
            src: undefined,
            blurhash: undefined,
            width: undefined,
            height: undefined,
        };
    }

    const [src, fragment = ""] = url.split("#", 2);
    const params = new URLSearchParams(fragment);
    const width = params.get("width");
    const height = params.get("height");

    return {
        src,
        blurhash: params.get("blurhash") || undefined,
        width: width ? Number.parseInt(width, 10) : undefined,
        height: height ? Number.parseInt(height, 10) : undefined,
    };
}

export function listMarkdownImageUrls(content: string) {
    const imagePattern = /!\[.*?\]\((\S+?)(?:\s+"[^"]*")?\)/g;
    const matches: string[] = [];

    for (const match of content.matchAll(imagePattern)) {
        if (match[1]) {
            matches.push(match[1]);
        }
    }

    return matches;
}

export function listHtmlImageUrls(content: string) {
    const imagePattern = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
    const matches: string[] = [];

    for (const match of content.matchAll(imagePattern)) {
        if (match[1]) {
            matches.push(match[1]);
        }
    }

    return matches;
}

export function listContentImageUrls(content: string) {
    return [...listMarkdownImageUrls(content), ...listHtmlImageUrls(content)];
}

export function contentHasImagesMissingMetadata(content: string) {
    return listContentImageUrls(content).some((url) => {
        const metadata = parseImageMetadataFromUrl(url);
        return !metadata.blurhash || !metadata.width || !metadata.height;
    });
}

export function extractImage(content: string) {
    const urls = listContentImageUrls(content);
    for (const url of urls) {
        if (url.startsWith('data:')) continue;
        return stripImageMetadataFromUrl(url);
    }
    return undefined;
}

export function extractImageWithMetadata(content: string) {
    const urls = listContentImageUrls(content);
    for (const url of urls) {
        if (url.startsWith('data:')) continue;
        return url;
    }
    return undefined;
}

// 提取文章封面：优先首图（保留 blurhash/尺寸元数据），无图时回退到 <video poster>。
// 用于列表卡片与后台管理页的缩略图；视频文章若带 poster 即显示视频缩略图，
// 否则返回 undefined（由前端回退到视频占位图标）。视频 src 是媒体文件本身，
// 不能作为 <img> 缩略图，故仅在确有 poster 时才返回。
export function extractCoverWithMetadata(content: string): string | undefined {
    const image = extractImageWithMetadata(content);
    if (image) return image;

    const videoTag = content.match(/<video\b[^>]*>/i);
    if (videoTag) {
        const poster = videoTag[0].match(/\bposter=["']([^"']+)["']/i);
        if (poster?.[1]) return poster[1];
    }
    return undefined;
}
