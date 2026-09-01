import { a3 as head, a4 as attr_class, a8 as attr_style, a6 as escape_html, a5 as attr } from '../../../../../chunks/index.js-BDRgBx0K.js';
import '../../../../../chunks/exports.js-BZBK1HC9.js';
import '../../../../../chunks/utils2.js-BQzn9ikS.js';
import '../../../../../chunks/utils.js-DNDl--Fb.js';
import '../../../../../chunks/root.js-C4XJ2ICJ.js';
import '../../../../../chunks/state.svelte.js-DFV3kIz4.js';
import { p as page } from '../../../../../chunks/index2.js-CPx5pGSX.js';
import { o as offlineMediaKey, a as offlineAvailability } from '../../../../../chunks/offline.js-BZ0Jbt3M.js';

function episodePlaybackMedia(show, season, episodeNumber, episodes) {
  const episode = episodes.find((item) => String(item.number) === String(episodeNumber));
  const selectedSeason = Number(season);
  const selectedEpisode = Number(episodeNumber);
  if (!show || !episode || !Number.isInteger(selectedSeason) || selectedSeason < 1 || !Number.isInteger(selectedEpisode) || selectedEpisode < 1) {
    return null;
  }
  return {
    ...show,
    season: selectedSeason,
    episode: selectedEpisode,
    episodeTitle: episode.name,
    ...episode.runtime ? { durationHint: episode.runtime * 60 } : {}
  };
}
function _page($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    const media = {
      id: Number(page.params.id),
      type: page.params.type,
      title: page.url.searchParams.get("title") || "",
      year: page.url.searchParams.get("year") || "",
      poster: page.url.searchParams.get("poster") || ""
    };
    page.url.searchParams.get("season") || "";
    page.url.searchParams.get("episode") || "";
    const shouldResume = page.url.searchParams.get("resume") === "1";
    page.url.searchParams.get("play") === "1" || shouldResume;
    let episodes = [];
    let selectedSeason = "";
    let selectedEpisode = "";
    let playback = null;
    let guideOpen = false;
    let playerRevealing = false;
    let titleDetails = {
      backdrop: page.url.searchParams.get("backdrop") || ""
    };
    let library = [];
    let progressEntries = [];
    let offlineDownloads = [];
    let offlineJobs = [];
    function activeDownload(item = media) {
      const key = offlineMediaKey(item);
      return offlineJobs.find((job) => job.key === key && !["ready", "error"].includes(job.status));
    }
    function downloaded(item = media) {
      return offlineAvailability(item, offlineDownloads);
    }
    function itemKey(item) {
      return item?.type === "tv" ? `${item.type}:${item.id}:s${item.season}:e${item.episode}` : `${item?.type}:${item?.id}`;
    }
    function progressFor(item) {
      const key = itemKey(item);
      return progressEntries.find((entry) => itemKey(entry.media) === key);
    }
    function selectedMediaItem() {
      return media.type === "movie" ? media : episodePlaybackMedia(media, selectedSeason, selectedEpisode, episodes);
    }
    function isInLibrary() {
      return library.some((item) => item.id === media.id && item.type === media.type);
    }
    function isWatched(item = selectedMediaItem()) {
      return Boolean(progressFor(item)?.watched);
    }
    function watchToolbar($$renderer3, inPlayer) {
      $$renderer3.push(`<div${attr_class("player-toolbar watch-toolbar-bridge", void 0, {
        "hero-player-toolbar": !inPlayer,
        "player-toolbar-hidden": inPlayer
      })} aria-label="Watch actions">`);
      {
        $$renderer3.push("<!--[-1-->");
        $$renderer3.push(`<a class="player-toolbar-button player-toolbar-back" href="/" aria-label="Back to discover" title="Back to discover"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg></a>`);
      }
      $$renderer3.push(`<!--]--> <div class="player-toolbar-actions"><button${attr_class("player-toolbar-button", void 0, { "player-toolbar-button-active": isInLibrary() })}${attr("aria-label", isInLibrary() ? "Remove from library" : "Add to library")}${attr("title", isInLibrary() ? "Remove from library" : "Add to library")}>`);
      if (isInLibrary()) {
        $$renderer3.push("<!--[0-->");
        $$renderer3.push(`<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 3.75A1.75 1.75 0 0 1 7.75 2h8.5A1.75 1.75 0 0 1 18 3.75v17.1a.75.75 0 0 1-1.17.62L12 18.17l-4.83 3.3A.75.75 0 0 1 6 20.85V3.75Z"></path></svg>`);
      } else {
        $$renderer3.push("<!--[-1-->");
        $$renderer3.push(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M6.75 3.5h10.5v16.75L12 16.7l-5.25 3.55V3.5Z"></path><path d="M12 7v6M9 10h6"></path></svg>`);
      }
      $$renderer3.push(`<!--]--></button> `);
      {
        $$renderer3.push("<!--[0-->");
        if (activeDownload(media)) {
          $$renderer3.push("<!--[0-->");
          $$renderer3.push(`<a class="player-toolbar-button" href="/downloads"${attr("aria-label", `Download ${Math.round(activeDownload(media).progress || 0)} percent complete`)}${attr("title", `Downloading · ${Math.round(activeDownload(media).progress || 0)}%`)}><span class="loading loading-spinner loading-xs"></span></a>`);
        } else if (media.type === "tv") {
          $$renderer3.push("<!--[1-->");
          $$renderer3.push(`<button class="player-toolbar-button" aria-label="Download series" title="Download series"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 19h14"></path></svg>`);
          if (downloaded(media).count) {
            $$renderer3.push("<!--[0-->");
            $$renderer3.push(`<span class="player-toolbar-badge">${escape_html(downloaded(media).count)}</span>`);
          } else {
            $$renderer3.push("<!--[-1-->");
          }
          $$renderer3.push(`<!--]--></button>`);
        } else if (downloaded(media).available) {
          $$renderer3.push("<!--[2-->");
          $$renderer3.push(`<a class="player-toolbar-button player-toolbar-button-active" href="/downloads" aria-label="Open downloaded movie" title="Downloaded"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 19h14"></path><path d="m8.5 8 2 2 4-4"></path></svg></a>`);
        } else {
          $$renderer3.push("<!--[-1-->");
          $$renderer3.push(`<button class="player-toolbar-button" aria-label="Download movie" title="Download movie"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 19h14"></path></svg></button>`);
        }
        $$renderer3.push(`<!--]-->`);
      }
      $$renderer3.push(`<!--]--> <button${attr_class("player-toolbar-button", void 0, { "player-toolbar-button-active": isWatched() })}${attr("disabled", media.type === "tv" && !selectedEpisode, true)}${attr("aria-label", isWatched() ? "Mark unwatched" : "Mark watched")}${attr("title", isWatched() ? "Mark unwatched" : "Mark watched")}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="8.5"></circle>`);
      if (isWatched()) {
        $$renderer3.push("<!--[0-->");
        $$renderer3.push(`<path d="m8.25 12.15 2.45 2.45 5.05-5.2"></path>`);
      } else {
        $$renderer3.push("<!--[-1-->");
      }
      $$renderer3.push(`<!--]--></svg></button> `);
      {
        $$renderer3.push("<!--[-1-->");
      }
      $$renderer3.push(`<!--]--> `);
      if (media.type === "tv") {
        $$renderer3.push("<!--[0-->");
        $$renderer3.push(`<button${attr_class("player-toolbar-button", void 0, { "player-toolbar-button-active": guideOpen })}${attr("aria-expanded", guideOpen)} aria-controls="watch-guide" aria-label="Episodes" title="Episodes"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M9 6h10M9 12h10M9 18h10"></path><path d="m4.5 4.75 2 1.25-2 1.25V4.75Zm0 6 2 1.25-2 1.25v-2.5Zm0 6 2 1.25-2 1.25v-2.5Z"></path></svg></button>`);
      } else {
        $$renderer3.push("<!--[-1-->");
      }
      $$renderer3.push(`<!--]--></div></div>`);
    }
    head("1da171x", $$renderer2, ($$renderer3) => {
      $$renderer3.title(($$renderer4) => {
        $$renderer4.push(`<title>${escape_html(media.title ? `${media.title} · Watchhouse` : "Watch · Watchhouse")}</title>`);
      });
    });
    $$renderer2.push(`<section class="watch-page"><div${attr_class("watch-hero", void 0, {
      "watch-hero-playing": playback?.status === "ready",
      "watch-hero-revealing": playerRevealing
    })}${attr_style(`--watch-artwork: url("${titleDetails.backdrop || media.poster || ""}")`)}><div class="watch-hero-art" aria-hidden="true"></div> <div class="watch-hero-shade" aria-hidden="true"></div> `);
    watchToolbar($$renderer2, playback?.status === "ready");
    $$renderer2.push(`<!----> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div${attr_class("watch-identity", void 0, { "watch-identity-departing": playerRevealing })}><p class="page-eyebrow text-white/55">${escape_html(media.type === "tv" ? "Series" : "Film")}${escape_html(media.year ? ` · ${media.year}` : "")}`);
      if (media.type === "tv" && selectedSeason && selectedEpisode) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`· S${escape_html(String(selectedSeason).padStart(2, "0"))}E${escape_html(String(selectedEpisode).padStart(2, "0"))}`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--></p> <h1>${escape_html(media.title || "Watch")}</h1> `);
      {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--> `);
      {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--> <div class="hero-action-slot">`);
      {
        $$renderer2.push("<!--[-1-->");
        $$renderer2.push(`<button class="hero-identity-play"${attr("aria-label", `Play ${media.type === "tv" ? episodes.find((episode) => String(episode.number) === selectedEpisode)?.name || media.title : media.title}`)}><span aria-hidden="true">▶</span><span>Play${escape_html("")}</span></button>`);
      }
      $$renderer2.push(`<!--]--></div></div>`);
    }
    $$renderer2.push(`<!--]--> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div></section>`);
  });
}

export { _page as default };
//# sourceMappingURL=_page.svelte.js-CwH7ZAPk.js.map
