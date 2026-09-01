import { a3 as head, a6 as escape_html, a4 as attr, a5 as attr_class, a8 as attr_style, a7 as ensure_array_like } from '../../../../../chunks/index.js-CjwkDa6e.js';
import '../../../../../chunks/exports.js-BZBK1HC9.js';
import '../../../../../chunks/utils2.js-BQzn9ikS.js';
import '../../../../../chunks/utils.js-DNDl--Fb.js';
import '../../../../../chunks/root.js-BNc2O1GQ.js';
import '../../../../../chunks/state.svelte.js-syOl7ztk.js';
import { p as page } from '../../../../../chunks/index2.js-CXC-qFok.js';
import { o as offlineMediaKey, a as offlineAvailability, b as offlineEpisodeState } from '../../../../../chunks/offline.js-BReu0Ag4.js';

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
    page.url.searchParams.get("resume") === "1";
    let seasons = [];
    let episodes = [];
    let selectedSeason = "";
    let selectedEpisode = "";
    let playback = null;
    let releaseChoices = [];
    let library = [];
    let progressEntries = [];
    let offlineDownloads = [];
    let offlineJobs = [];
    let bulkUpdating = false;
    function activeDownload(item = media) {
      const key = offlineMediaKey(item);
      return offlineJobs.find((job) => job.key === key && !["ready", "error"].includes(job.status));
    }
    function downloaded(item = media) {
      return offlineAvailability(item, offlineDownloads);
    }
    function episodeDownloadState(item) {
      return offlineEpisodeState(item, offlineDownloads, offlineJobs);
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
    function watchedEpisodeNumbers(season) {
      return new Set(progressEntries.filter((entry) => entry.media.type === "tv" && entry.media.id === media.id && entry.media.season === Number(season) && entry.watched).map((entry) => entry.media.episode));
    }
    function isSeasonWatched() {
      return Boolean(episodes.length) && episodes.every((episode) => watchedEpisodeNumbers(selectedSeason).has(episode.number));
    }
    function isSeriesWatched() {
      return Boolean(seasons.length) && seasons.every((season) => season.episodeCount > 0 && watchedEpisodeNumbers(season.number).size >= season.episodeCount);
    }
    function formatAirDate(value) {
      if (!value) return "";
      const [year, month, day] = value.split("-").map(Number);
      if (!year || !month || !day) return value;
      return new Intl.DateTimeFormat(void 0, { day: "numeric", month: "short", year: "numeric" }).format(new Date(year, month - 1, day));
    }
    head("1da171x", $$renderer2, ($$renderer3) => {
      $$renderer3.title(($$renderer4) => {
        $$renderer4.push(`<title>${escape_html(media.title ? `${media.title} · Watchhouse` : "Watch · Watchhouse")}</title>`);
      });
    });
    $$renderer2.push(`<section class="watch-page py-2 sm:py-6"><a class="link link-hover text-sm text-base-content/60" href="/">← Back to discover</a> <div class="watch-heading mt-6 border-b border-base-300 pb-8 sm:flex sm:items-end sm:justify-between sm:gap-6"><div><p class="page-eyebrow">${escape_html(media.type === "tv" ? "Series" : "Film")}${escape_html(media.year ? ` · ${media.year}` : "")}</p><h1 class="mt-3 text-4xl sm:text-6xl">${escape_html(media.title || "Watch")}</h1>`);
    if (media.type === "tv" && selectedSeason && selectedEpisode) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<p class="mt-3 text-sm text-base-content/50">Season ${escape_html(selectedSeason)}, episode ${escape_html(selectedEpisode)}</p>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div><div class="watch-actions mt-5 flex flex-wrap gap-x-5 gap-y-2 sm:mt-0"><button class="btn btn-sm btn-ghost">${escape_html(isInLibrary() ? "Remove from library" : "+ Add to library")}</button>`);
    {
      $$renderer2.push("<!--[0-->");
      if (activeDownload(media)) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<a class="btn btn-sm btn-ghost" href="/downloads"><span class="loading loading-spinner loading-xs"></span>${escape_html(Math.round(activeDownload(media).progress || 0))}%</a>`);
      } else if (media.type === "tv") {
        $$renderer2.push("<!--[1-->");
        $$renderer2.push(`<button class="btn btn-sm btn-ghost">Download series${escape_html(downloaded(media).count ? ` (${downloaded(media).count} saved)` : "")}</button>`);
      } else if (downloaded(media).available) {
        $$renderer2.push("<!--[2-->");
        $$renderer2.push(`<a class="btn btn-sm btn-ghost" href="/downloads">Available offline</a>`);
      } else {
        $$renderer2.push("<!--[-1-->");
        $$renderer2.push(`<button class="btn btn-sm btn-ghost">Download movie</button>`);
      }
      $$renderer2.push(`<!--]-->`);
    }
    $$renderer2.push(`<!--]--><button class="btn btn-sm btn-ghost"${attr("disabled", media.type === "tv" && !selectedEpisode, true)}>${escape_html(isWatched() ? `Mark ${media.type === "tv" ? "episode " : ""}unwatched` : `Mark ${media.type === "tv" ? "episode " : ""}watched`)}</button></div></div> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <div${attr_class(`mt-8 grid gap-8 ${media.type === "tv" || releaseChoices.length ? "xl:grid-cols-[minmax(0,1fr)_24rem]" : ""}`)}><div>`);
    {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="player-shell detail-player relative grid aspect-video place-items-center overflow-hidden bg-black text-center svelte-1da171x"${attr_style(media.poster ? `background-image: linear-gradient(rgb(0 0 0 / 52%), rgb(0 0 0 / 82%)), url(${media.poster})` : void 0)}><div class="player-modal-panel relative z-10"><p class="player-eyebrow">${escape_html(media.type === "tv" ? `Season ${selectedSeason} · Episode ${selectedEpisode}` : "Feature presentation")}</p><h2>${escape_html(media.type === "tv" ? episodes.find((episode) => String(episode.number) === selectedEpisode)?.name || media.title : media.title)}</h2><button class="btn btn-lg btn-primary mt-7 min-w-44"><span class="text-base" aria-hidden="true">▶</span> Play now</button></div></div>`);
    }
    $$renderer2.push(`<!--]--> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div> `);
    if (media.type === "tv" || releaseChoices.length) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<aside class="episode-panel border-t border-base-300 pt-7 xl:border-l xl:border-t-0 xl:pl-8 xl:pt-0">`);
      if (media.type === "tv") {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<div class="flex flex-wrap items-end justify-between gap-4"><div><p class="page-eyebrow">Series guide</p><h2 class="episode-title mt-2">Episodes</h2><p class="mt-1 text-xs text-base-content/45">Select an episode to start watching</p></div> <div class="flex flex-wrap items-center justify-end gap-2"><details${attr_class("dropdown dropdown-end", void 0, { "pointer-events-none": !seasons.length })}><summary${attr_class("btn btn-sm btn-ghost min-w-40 justify-between", void 0, { "opacity-50": !seasons.length })}${attr("aria-disabled", !seasons.length)}${attr("aria-busy", !seasons.length && playback?.status !== "error")}><span>${escape_html(seasons.find((season) => String(season.number) === selectedSeason)?.name || "Loading seasons…")}</span><span aria-hidden="true">⌄</span></summary> `);
        if (seasons.length) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<ul class="editorial-menu menu dropdown-content z-30 mt-2 max-h-72 w-56 overflow-y-auto border border-base-300 bg-base-100 p-1" aria-label="Choose season"><!--[-->`);
          const each_array = ensure_array_like(seasons);
          for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
            let season = each_array[$$index];
            $$renderer2.push(`<li><button${attr("aria-current", String(season.number) === selectedSeason ? "true" : void 0)}${attr_class("", void 0, { "menu-active": String(season.number) === selectedSeason })}><span>${escape_html(season.name)}</span><span class="ml-auto text-[10px] text-base-content/40">${escape_html(season.episodeCount)} EP</span></button></li>`);
          }
          $$renderer2.push(`<!--]--></ul>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--></details> <details${attr_class("dropdown dropdown-end", void 0, { "pointer-events-none": !episodes.length || bulkUpdating })}><summary${attr_class("btn btn-sm btn-ghost", void 0, { "opacity-50": !episodes.length || bulkUpdating })}${attr("aria-disabled", !episodes.length || bulkUpdating)}>Bulk actions <span aria-hidden="true">⌄</span></summary> <ul class="editorial-menu menu dropdown-content z-30 mt-2 w-56 border border-base-300 bg-base-100 p-1" aria-label="Bulk episode actions"><li><button>${escape_html(isSeasonWatched() ? "Mark season unwatched" : "Mark season watched")}</button></li> <li><button>${escape_html(isSeriesWatched() ? "Mark series unwatched" : "Mark series watched")}</button></li> `);
        {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<li><button>Download season ${escape_html(selectedSeason)}</button></li>`);
        }
        $$renderer2.push(`<!--]--></ul></details></div></div> `);
        if (episodes.length) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<div class="episode-list mt-5 max-h-[34rem] divide-y divide-base-300 overflow-y-auto border-y border-base-300"><!--[-->`);
          const each_array_1 = ensure_array_like(episodes);
          for (let $$index_1 = 0, $$length = each_array_1.length; $$index_1 < $$length; $$index_1++) {
            let episode = each_array_1[$$index_1];
            const episodeMedia = {
              ...media,
              season: Number(selectedSeason),
              episode: episode.number,
              episodeTitle: episode.name
            };
            const episodeWatched = isWatched(episodeMedia);
            const downloadState = episodeDownloadState(episodeMedia);
            $$renderer2.push(`<div${attr_class("episode-row group flex w-full items-center text-left transition-colors hover:bg-base-200", void 0, { "bg-base-200": String(episode.number) === selectedEpisode })}><button class="flex min-w-0 flex-1 items-center gap-4 py-4 pl-4 pr-2 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"${attr("aria-current", String(episode.number) === selectedEpisode ? "true" : void 0)}${attr("aria-label", `Play episode ${episode.number}, ${episode.name}`)}><span class="episode-marker grid h-10 w-10 shrink-0 place-items-center border border-base-300 text-sm font-semibold text-base-content/55 transition-colors group-hover:border-primary group-hover:bg-primary group-hover:text-primary-content">`);
            {
              $$renderer2.push("<!--[-1-->");
              $$renderer2.push(`<svg class="h-4 w-4 translate-x-px" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M5.5 3.9a1 1 0 0 1 1.52-.85l9.1 6.1a1 1 0 0 1 0 1.7l-9.1 6.1a1 1 0 0 1-1.52-.85V3.9Z"></path></svg>`);
            }
            $$renderer2.push(`<!--]--></span> <span class="min-w-0 flex-1"><span class="flex items-baseline gap-2"><span class="text-xs font-semibold text-base-content/50">${escape_html(episode.number)}</span><span class="truncate text-sm font-medium group-hover:text-primary">${escape_html(episode.name)}</span></span>`);
            if (episode.airDate) {
              $$renderer2.push("<!--[0-->");
              $$renderer2.push(`<span class="mt-1 block text-xs text-base-content/50">${escape_html(formatAirDate(episode.airDate))}</span>`);
            } else {
              $$renderer2.push("<!--[-1-->");
            }
            $$renderer2.push(`<!--]--></span></button> `);
            {
              $$renderer2.push("<!--[0-->");
              $$renderer2.push(`<button class="episode-watched grid size-9 shrink-0 place-items-center hover:bg-base-300 hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"${attr("disabled", !["available", "error"].includes(downloadState.status), true)}${attr("aria-label", downloadState.status === "ready" ? `Episode ${episode.number} is downloaded` : downloadState.status === "error" ? `Retry download for episode ${episode.number}` : `Download episode ${episode.number}`)}${attr("title", downloadState.status === "ready" ? "Downloaded" : downloadState.status === "error" ? "Retry download" : "Download episode")}>`);
              if (["selecting", "downloading", "extracting", "optimizing"].includes(downloadState.status)) {
                $$renderer2.push("<!--[0-->");
                $$renderer2.push(`<span class="loading loading-spinner loading-xs"></span>`);
              } else if (downloadState.status === "ready") {
                $$renderer2.push("<!--[1-->");
                $$renderer2.push(`<svg class="size-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 13.5v2h12v-2M10 3v9m-3-3 3 3 3-3"></path></svg>`);
              } else if (downloadState.status === "error") {
                $$renderer2.push("<!--[2-->");
                $$renderer2.push(`<span aria-hidden="true">↻</span>`);
              } else {
                $$renderer2.push("<!--[-1-->");
                $$renderer2.push(`<span aria-hidden="true">↓</span>`);
              }
              $$renderer2.push(`<!--]--></button>`);
            }
            $$renderer2.push(`<!--]--> <button${attr_class("episode-watched mr-2 grid size-9 shrink-0 place-items-center text-sm hover:bg-base-300 hover:text-primary focus-visible:outline-2 focus-visible:outline-primary", void 0, { "text-primary": episodeWatched })}${attr("aria-label", episodeWatched ? `Mark episode ${episode.number} unwatched` : `Mark episode ${episode.number} watched`)}${attr("aria-pressed", episodeWatched)}>${escape_html(episodeWatched ? "✓" : "○")}</button></div>`);
          }
          $$renderer2.push(`<!--]--></div>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]-->`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--> `);
      if (releaseChoices.length) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<div class="release-picker mt-8 border-t border-base-300 pt-6" tabindex="-1" aria-labelledby="release-picker-title"><p class="page-eyebrow" id="release-picker-title">Choose a release</p><div class="mt-4 divide-y divide-base-300 border-y border-base-300"><!--[-->`);
        const each_array_3 = ensure_array_like(releaseChoices);
        for (let $$index_3 = 0, $$length = each_array_3.length; $$index_3 < $$length; $$index_3++) {
          let release = each_array_3[$$index_3];
          $$renderer2.push(`<button class="release-option flex w-full items-start justify-between gap-3 py-4 text-left hover:text-primary"><span class="min-w-0"><span class="block truncate text-sm font-medium">${escape_html(release.title)}</span><span class="mt-1 block text-xs text-base-content/45">${escape_html(release.readiness.label)} · ${escape_html(release.category)}</span></span>`);
          if (release.size) {
            $$renderer2.push("<!--[0-->");
            $$renderer2.push(`<span class="shrink-0 text-xs text-base-content/45">${escape_html(release.size)}</span>`);
          } else {
            $$renderer2.push("<!--[-1-->");
          }
          $$renderer2.push(`<!--]--></button>`);
        }
        $$renderer2.push(`<!--]--></div></div>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--></aside>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div></section>`);
  });
}

export { _page as default };
//# sourceMappingURL=_page.svelte.js-C2VtSEvW.js.map
