// Renders one slide by its layout. Every piece of text is real DOM text
// (slide-system-rules.md §§0.4, 8) — never baked into an image or canvas.
// `step` drives click-reveal; `revealAll` forces everything visible (used by
// the presenter view's "next slide" preview).

import type { Slide, SlideImage } from "@/lib/types";
import { visibleRevealCount } from "@/lib/deckUtils";
import { diagrams } from "./diagrams";

function accentClass(accent?: Slide["accent"]): string {
  return accent ? `accent-${accent}` : "";
}

function renderImage(image: SlideImage) {
  // Prefer an inline diagram (real DOM text); fall back to a file in /public.
  if (image.inline) {
    const Diagram = diagrams[image.inline];
    if (Diagram) return <Diagram />;
  }
  if (image.src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={image.src} alt={image.alt} />;
  }
  return null;
}

export function SlideView({
  slide,
  step,
  revealAll = false,
}: {
  slide: Slide;
  step: number;
  revealAll?: boolean;
}) {
  const visible = visibleRevealCount(slide, step, revealAll);
  const shown = (i: number) => i < visible;
  const revealClass = (i: number) =>
    slide.reveal ? (shown(i) ? "reveal-shown" : "reveal-hidden") : "";

  const eyebrow = slide.eyebrow ? <p className="eyebrow">{slide.eyebrow}</p> : null;

  return (
    <div className={`slide layout-${slide.layout} ${accentClass(slide.accent)}`.trim()}>
      {renderBody()}
    </div>
  );

  function renderBody() {
    switch (slide.layout) {
      case "title":
        return (
          <>
            {eyebrow}
            {slide.title && <h1 className="slide-title">{slide.title}</h1>}
            {slide.subtitle && <p className="slide-subtitle">{slide.subtitle}</p>}
          </>
        );

      case "section":
        return (
          <>
            {eyebrow}
            {slide.title && <h1 className="slide-title">{slide.title}</h1>}
            <div className="accent-rule" aria-hidden="true" />
          </>
        );

      case "statement":
        return (
          <>
            {eyebrow}
            {slide.body && <p className="statement-body">{slide.body}</p>}
          </>
        );

      case "bullets":
        return (
          <>
            {eyebrow}
            {slide.title && <h2 className="slide-title">{slide.title}</h2>}
            <ul className="bullet-list">
              {slide.bullets?.map((b, i) => (
                <li key={i} className={revealClass(i)}>
                  {b}
                </li>
              ))}
            </ul>
          </>
        );

      case "two-col": {
        // Reveal counts across columns in reading order.
        const offsets: number[] = [];
        let running = 0;
        for (const col of slide.columns ?? []) {
          offsets.push(running);
          running += col.bullets.length;
        }
        return (
          <>
            {eyebrow}
            {slide.title && <h2 className="slide-title">{slide.title}</h2>}
            <div className="cols">
              {slide.columns?.map((col, ci) => (
                <div key={ci}>
                  {col.heading && <h3 className="col-heading">{col.heading}</h3>}
                  <ul className="col-list">
                    {col.bullets.map((b, bi) => (
                      <li key={bi} className={revealClass(offsets[ci] + bi)}>
                        {b}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </>
        );
      }

      case "quote":
        return (
          <>
            <div className="quote-mark" aria-hidden="true">
              &ldquo;
            </div>
            {slide.quote && <blockquote>{slide.quote}</blockquote>}
            {slide.attribution && <p className="attribution">— {slide.attribution}</p>}
          </>
        );

      case "image":
        return (
          <>
            {eyebrow}
            {slide.title && <h2 className="slide-title">{slide.title}</h2>}
            <div className="image-frame">
              {slide.image && renderImage(slide.image)}
            </div>
            {slide.image?.caption && <p className="caption">{slide.image.caption}</p>}
          </>
        );

      default:
        return null;
    }
  }
}
