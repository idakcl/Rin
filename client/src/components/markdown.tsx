import "katex/dist/katex.min.css";
import React, { cloneElement, isValidElement, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { AudioPlayer } from "./audio-player";
import {
  base16AteliersulphurpoolLight,
  vscDarkPlus,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import gfm from "remark-gfm";
import remarkMermaid from "../remark/remarkMermaid";
import { remarkAlert } from "remark-github-blockquote-alert";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import Lightbox, { SlideImage } from "yet-another-react-lightbox";
import Counter from "yet-another-react-lightbox/plugins/counter";
import Download from "yet-another-react-lightbox/plugins/download";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import "yet-another-react-lightbox/styles.css";
import { drawBlurhashToCanvas } from "../utils/blurhash";
import { useColorMode } from "../utils/darkModeUtils";
import { parseImageUrlMetadata } from "../utils/image-upload";
import { useImageLoadState } from "../utils/use-image-load-state";

// ---------------------------------------------------------------------------
// 文章图片并发加载控制器
// 用 IntersectionObserver 决定「何时加载」，用计数器 + 队列把「同时在飞」的图片
// 限制在 MAX_CONCURRENT_IMAGES 张以内，并按距视口远近排序（近的优先），避免长图
// 文章一次性发起几十个请求导致后面的图被并发「饿死」停在模糊占位。
// 控制器为模块级单例，整篇文章（乃至整页）共享同一组并发槽。
// ---------------------------------------------------------------------------
const MAX_CONCURRENT_IMAGES = 5;

type ImageLoadEntry = {
  el: HTMLImageElement;
  src: string;
  priority: number; // 距视口垂直距离，越小越优先
  load: () => void; // 通知 React 给 <img> 设置真实 src
};

let imageLoadingCount = 0;
const imageEntries = new Map<HTMLElement, ImageLoadEntry>();
let imageQueue: ImageLoadEntry[] = [];
let imageObserver: IntersectionObserver | null = null;

function getImageObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") {
    return null;
  }
  if (imageObserver) {
    return imageObserver;
  }
  imageObserver = new IntersectionObserver(
    (obsEntries) => {
      for (const entry of obsEntries) {
        const el = entry.target as HTMLImageElement;
        const item = imageEntries.get(el);
        // 进入视口(提前 200px)且尚未排队/加载，才请求
        if (entry.isIntersecting && item && !el.dataset.loadState) {
          requestImageLoad(item);
        }
      }
    },
    { rootMargin: "200px" }
  );
  return imageObserver;
}

function requestImageLoad(item: ImageLoadEntry) {
  if (item.el.dataset.loadState) {
    return; // 已在排队/加载，防重
  }
  item.priority = Math.abs(item.el.getBoundingClientRect().top);
  if (imageLoadingCount >= MAX_CONCURRENT_IMAGES) {
    item.el.dataset.loadState = "queued";
    imageQueue.push(item);
    imageQueue.sort((a, b) => a.priority - b.priority); // 离视口近的优先
  } else {
    startImageLoad(item);
  }
}

function startImageLoad(item: ImageLoadEntry) {
  imageLoadingCount++;
  item.el.dataset.loadState = "loading";
  item.load(); // 触发 React 设置真实 src，浏览器开始拉取
}

function releaseImageSlot(el: HTMLElement | null) {
  if (!el) return;
  const item = imageEntries.get(el);
  if (!item || item.el.dataset.loadState !== "loading") {
    return;
  }
  item.el.dataset.loadState = "done"; // 已完成，避免滚回视口时重复请求导致并发槽泄漏
  imageLoadingCount--;
  drainImageQueue();
}

function drainImageQueue() {
  while (imageLoadingCount < MAX_CONCURRENT_IMAGES && imageQueue.length > 0) {
    const next = imageQueue.shift()!;
    if (next.el.isConnected) {
      startImageLoad(next);
    } else {
      imageEntries.delete(next.el); // 元素已卸载，丢弃
    }
  }
}


const countNewlinesBeforeNode = (text: string, offset: number) => {
  let newlinesBefore = 0;
  for (let i = offset - 1; i >= 0; i--) {
    if (text[i] === "\n") {
      newlinesBefore++;
    } else {
      break;
    }
  }
  return newlinesBefore;
};

const isMarkdownImageLinkAtEnd = (text: string) => {
  const trimmed = text.trim();

  const match = trimmed.match(/(.*)(!\\[.*?\\]\\(.*?\\))$/s);

  if (match) {
    const [, beforeImage, _] = match;

    return beforeImage.trim().length === 0 || beforeImage.endsWith("\n");
  }

  return false;
};

function MarkdownImage({
  src,
  alt,
  show,
  rounded,
  scale,
  className,
}: {
  src?: string;
  alt?: string;
  show: (src?: string) => void;
  rounded: boolean;
  scale: string;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { src: cleanSrc, blurhash, width, height } = parseImageUrlMetadata(src);
  const [actualSrc, setActualSrc] = useState<string | undefined>(undefined);
  const { failed, imageRef, loaded, onError, onLoad } = useImageLoadState(actualSrc);
  const roundedClass = rounded ? "rounded-xl" : "";
  const aspectRatio = width && height ? `${width} / ${height}` : undefined;

  useEffect(() => {
    if (!blurhash || !canvasRef.current) {
      return;
    }
    try {
      drawBlurhashToCanvas(canvasRef.current, blurhash);
    } catch (error) {
      console.error("Failed to render blurhash", error);
    }
  }, [blurhash]);

  // 注册到并发加载控制器：进入视口(提前 200px)才排队/加载，全局最多 5 张同时在飞。
  // 延迟设置真实 src，避免长图文章一次性发起几十个请求把后面的图「饿死」。
  useEffect(() => {
    const el = imageRef.current;
    if (!el || !cleanSrc) {
      return;
    }
    const item: ImageLoadEntry = {
      el,
      src: cleanSrc,
      priority: 0,
      load: () => setActualSrc(cleanSrc),
    };
    imageEntries.set(el, item);
    const obs = getImageObserver();
    obs?.observe(el);
    return () => {
      obs?.unobserve(el);
      imageEntries.delete(el);
      imageQueue = imageQueue.filter((q) => q.el !== el);
      if (el.dataset.loadState === "loading") {
        imageLoadingCount--;
        drainImageQueue();
      }
      el.dataset.loadState = "";
      setActualSrc(undefined);
    };
  }, [cleanSrc]);

  const handleLoad = () => {
    onLoad();
    releaseImageSlot(imageRef.current);
  };
  const handleError = () => {
    onError();
    releaseImageSlot(imageRef.current);
  };

  return (
    <span
      className={`relative inline-block max-w-full overflow-hidden ${roundedClass}`}
      style={{ zoom: scale, aspectRatio }}
    >
      {blurhash && !loaded ? (
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className={`absolute inset-0 h-full w-full scale-110 blur-sm ${roundedClass}`}
        />
      ) : null}
      <img
        ref={imageRef}
        src={actualSrc}
        alt={alt}
        width={width}
        height={height}
        decoding="async"
        onClick={() => {
          show(cleanSrc);
        }}
        onLoad={handleLoad}
        onError={handleError}
        className={`mx-auto max-w-full cursor-zoom-in transition-opacity ${roundedClass} ${className || ""} ${
          blurhash && (!loaded || failed) ? "opacity-0" : "opacity-100"
        }`}
      />
    </span>
  );
}

export function Markdown({ content }: { content: string }) {
  const colorMode = useColorMode();
  const [index, setIndex] = React.useState(-1);
  const slides = useRef<SlideImage[]>();

  useEffect(() => {
    slides.current = undefined;
  }, [content]);



  const Content = useMemo(() => (
    <ReactMarkdown
      className="toc-content dark:text-neutral-300"
      remarkPlugins={[gfm, remarkMermaid, remarkMath, remarkAlert, remarkBreaks]}
      children={content}
      rehypePlugins={[rehypeKatex, rehypeRaw]}
      components={{
        img({ node, src, ...props }) {
          const offset = node!.position!.start.offset!;
          const previousContent = content.slice(0, offset);
          const newlinesBefore = countNewlinesBeforeNode(
            previousContent,
            offset
          );
          const Image = ({
            rounded,
            scale,
          }: {
            rounded: boolean;
            scale: string;
          }) => (
            <MarkdownImage
              src={src}
              alt={props.alt}
              show={show}
              rounded={rounded}
              scale={scale}
              className={props.className}
            />
          );
          if (
            newlinesBefore >= 1 ||
            previousContent.trim().length === 0 ||
            isMarkdownImageLinkAtEnd(previousContent)
          ) {
            return (
              <span className="block w-full text-center my-4">
                <Image scale="0.75" rounded={true} />
              </span>
            );
          } else {
            return (
              <span className="inline-block align-middle mx-1 ">
                <Image scale="0.5" rounded={false} />
              </span>
            );
          }
        },
        code(props) {
          const [copied, setCopied] = React.useState(false);
          const { children, className, node, ...rest } = props;
          const match = /language-(\w+)/.exec(className || "");

          const curContent = content.slice(node?.position?.start.offset || 0);
          const isCodeBlock = curContent.trimStart().startsWith("```");

          const codeBlockStyle = {
            fontFamily: 'ui-monospace, "SFMono-Regular", "SF Mono", Consolas, "Liberation Mono", Menlo, monospace',
            fontSize: "14px",
            fontVariantLigatures: "normal",
            WebkitFontFeatureSettings: '"liga" 1',
            fontFeatureSettings: '"liga" 1',
          };

          const inlineCodeStyle = {
            ...codeBlockStyle,
            fontSize: "13px",
          };

          const language = match ? match[1] : "";

          if (isCodeBlock) {
            return (
              <div className="relative group">
                <SyntaxHighlighter
                  PreTag="div"
                  className="rounded"
                  language={language}
                  style={
                    colorMode === "dark"
                      ? vscDarkPlus
                      : base16AteliersulphurpoolLight
                  }
                  wrapLongLines={true}
                  codeTagProps={{ style: codeBlockStyle }}
                >
                  {String(children).replace(/\n$/, "")}
                </SyntaxHighlighter>
                <button className="absolute top-1 right-1 px-2 py-1 bg-w rounded-md text-sm bg-hover select-none invisible group-hover:visible"
                  onClick={() => {
                    navigator.clipboard.writeText(String(children));
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
            );
          } else {
            return (
              <code
                {...rest}
                className={`bg-[#eff1f3] dark:bg-[#4a5061] h-[24px] px-[4px] rounded-md mx-[2px] py-[2px] text-neutral-800 dark:text-neutral-300 ${className || ""
                  }`}
                style={inlineCodeStyle}
              >
                {children}
              </code>
            );
          }
        },
        blockquote({ children, ...props }) {
          return (
            <blockquote
              className="border-l-4 border-gray-300 dark:border-gray-500 pl-4 italic text-gray-500 dark:text-gray-400"
              {...props}
            >
              {children}
            </blockquote>
          );
        },
        em({ children, ...props }) {
          return (
            <em className="ml-[1px] mr-[4px]" {...props}>
              {children}
            </em>
          );
        },
        strong({ children, ...props }) {
          return (
            <strong className="mx-[1px]" {...props}>
              {children}
            </strong>
          );
        },

        ul({ children, className, ...props }) {
          const listClass = className?.includes("contains-task-list")
            ? "list-none pl-5"
            : "list-disc pl-5 mt-2";
          return (
            <ul className={listClass} {...props}>
              {children}
            </ul>
          );
        },
        ol({ children, ...props }) {
          return (
            <ol className="list-decimal pl-5" {...props}>
              {children}
            </ol>
          );
        },
        li({ children, ...props }) {
          return (
            <li className="pl-2 py-1" {...props}>
              {children}
            </li>
          );
        },
        a({ children, ...props }) {
          return (
            <a
              className="text-[#0686c8] dark:text-[#2590f1] hover:underline"
              {...props}
            >
              {children}
            </a>
          );
        },
        h1({ children, ...props }) {
          return (
            <h1
              id={children?.toString()}
              {...props}
              className={`${props.className || ""} text-3xl font-bold mt-4`.trim()}
              style={{ ...props.style, scrollMarginTop: "var(--header-scroll-offset, 7rem)" }}
            >
              {children}
            </h1>
          );
        },
        h2({ children, ...props }) {
          return (
            <h2
              id={children?.toString()}
              {...props}
              className={`${props.className || ""} text-2xl font-bold mt-4`.trim()}
              style={{ ...props.style, scrollMarginTop: "var(--header-scroll-offset, 7rem)" }}
            >
              {children}
            </h2>
          );
        },
        h3({ children, ...props }) {
          return (
            <h3
              id={children?.toString()}
              {...props}
              className={`${props.className || ""} text-xl font-bold mt-4`.trim()}
              style={{ ...props.style, scrollMarginTop: "var(--header-scroll-offset, 7rem)" }}
            >
              {children}
            </h3>
          );
        },
        h4({ children, ...props }) {
          return (
            <h4
              id={children?.toString()}
              {...props}
              className={`${props.className || ""} text-lg font-bold mt-4`.trim()}
              style={{ ...props.style, scrollMarginTop: "var(--header-scroll-offset, 7rem)" }}
            >
              {children}
            </h4>
          );
        },
        h5({ children, ...props }) {
          return (
            <h5
              id={children?.toString()}
              {...props}
              className={`${props.className || ""} text-base font-bold mt-4`.trim()}
              style={{ ...props.style, scrollMarginTop: "var(--header-scroll-offset, 7rem)" }}
            >
              {children}
            </h5>
          );
        },
        h6({ children, ...props }) {
          return (
            <h6
              id={children?.toString()}
              {...props}
              className={`${props.className || ""} text-sm font-bold mt-4`.trim()}
              style={{ ...props.style, scrollMarginTop: "var(--header-scroll-offset, 7rem)" }}
            >
              {children}
            </h6>
          );
        },
        p({ children, node, ...props }) {
          return (
            <p className="mt-2 py-1" {...props}>
              {children}
            </p>
          );
        },
        hr({ children, ...props }) {
          return <hr className="my-4" {...props} />;
        },
        table: ({ node, ...props }) => <table className="table" {...props} />,
        th: ({ node, ...props }) => (
          <th className="px-4 py-2 border bg-gray-600" {...props} />
        ),
        td: ({ node, ...props }) => (
          <td className="px-4 py-2 border" {...props} />
        ),
        sup: ({ children, ...props }) => (
          <sup className="text-xs mr-[4px]" {...props}>
            {children}
          </sup>
        ),
        sub: ({ children, ...props }) => (
          <sub className="text-xs mr-[4px]" {...props}>
            {children}
          </sub>
        ),
        section({ children, ...props }) {
          if (props.hasOwnProperty("data-footnotes")) {
            props.className = `${props.className || ""} mt-8`.trim();
          }
          const modifiedChildren = React.Children.map(children, (child) => {
            if (isValidElement(child) && child.props.node.tagName === "ol") {
              return cloneElement(child, {
                ...child.props,
                className: "list-decimal px-10 text-sm text-[#6B7280]",
              } as React.HTMLAttributes<HTMLParagraphElement>);
            }
            return child;
          });
          return <section {...props}>{modifiedChildren}</section>;
        },
        iframe({ node, src, title, ...props }) {
          return (
            <div className="my-4 w-full">
              <iframe
                {...props}
                src={src}
                title={title || "Embedded content"}
                className="w-full rounded-xl border border-black/10 dark:border-white/10"
                style={{ minHeight: "400px" }}
                loading="lazy"
                referrerPolicy="no-referrer"
                sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
              />
            </div>
          );
        },
        div({ children, node, ...props }) {
          return <div {...props}>{children}</div>;
        },
        audio({ node }) {
          // Read all attributes from the hast node directly: this avoids
          // relying on react-markdown's per-tag prop typings (which omit
          // autoplay/loop on <audio>) and handles data-* uniformly.
          const props = (node?.properties ?? {}) as Record<string, unknown>;
          const src = typeof props.src === "string" ? props.src : undefined;
          const autoplay = props.autoplay !== undefined && props.autoplay !== false;
          const loop = props.loop !== undefined && props.loop !== false;
          const dataName = (props.dataName ?? props["data-name"]) as string | undefined;
          return (
            <AudioPlayer
              src={src}
              autoplay={autoplay}
              loop={loop}
              name={dataName}
            />
          );
        },
      }}
    />), [content])



  const show = (src: string | undefined) => {
    let slidesLocal = slides.current;
    if (!slidesLocal) {
      const parent = document.getElementsByClassName("toc-content")[0];
      if (!parent) return;
      const images = parent.querySelectorAll("img");
      slidesLocal = Array.from(images)
        .map((image) => {
          const url = image.getAttribute("src") || "";
          const filename = url.split("/").pop() || "";
          const alt = image.getAttribute("alt") || "";
          return {
            src: url,
            alt: alt,
            imageFit: "contain" as const,
            download: {
              url: url,
              filename: filename,
            },
          };
        })
        .filter((slide) => slide.src !== "");
      slides.current = (slidesLocal);
    }
    const index = slidesLocal?.findIndex((slide) => slide.src === src) ?? -1;
    setIndex(index);
  };

  return (
    <>
      {Content}
      <Lightbox
        plugins={[Download, Zoom, Counter]}
        index={index}
        slides={slides.current}
        open={index >= 0}
        close={() => setIndex(-1)}
      />
    </>
  );
}
