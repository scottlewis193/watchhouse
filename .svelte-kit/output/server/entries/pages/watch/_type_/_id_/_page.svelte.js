import { e as escape_html, a as attr, d as attr_style, h as head, c as attr_class, b as ensure_array_like } from "../../../../../chunks/index.js";
import { p as page } from "../../../../../chunks/index2.js";
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
function PlaybackPreparation($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let {
      title,
      message = "",
      progress = 0,
      download = null,
      detailed = false,
      error = false
    } = $$props;
    function formatBytes(bytes) {
      if (!bytes) return "";
      const units = ["B", "KB", "MB", "GB"];
      let value = bytes, index = 0;
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index++;
      }
      return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
    }
    $$renderer2.push(`<div class="playback-preparation relative grid size-full overflow-hidden border border-base-300 bg-base-100 p-6 sm:p-10"><div class="playback-glow pointer-events-none absolute -right-20 -top-24 size-72 rounded-full bg-primary/8 blur-3xl"></div> <div class="relative m-auto w-full max-w-md text-center"><span class="playback-mark mx-auto grid size-11 place-items-center border border-primary/60 text-[11px] font-bold text-primary"><span class="brand-initials">WH</span></span> <p class="mt-5 text-[11px] font-semibold tracking-[0.2em] text-base-content/45">PREPARING PLAYBACK</p> <h2 class="mt-3 text-xl font-semibold tracking-tight sm:text-2xl">${escape_html(title)}</h2> `);
    if (detailed && message) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<p class="mt-2 text-sm text-base-content/60">${escape_html(message)}</p>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    if (!error) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="preparation-progress mx-auto mt-6 h-px w-full max-w-xs overflow-hidden bg-base-300" role="progressbar" aria-label="Preparing playback"${attr("aria-valuenow", Math.round(progress || 0))} aria-valuemin="0" aria-valuemax="100"><div class="preparation-progress-fill h-full bg-primary transition-[width] duration-500"${attr_style(`width: ${Math.min(100, Math.max(3, progress || 0))}%`)}></div></div> `);
      if (detailed) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<p class="mt-3 text-xs tabular-nums text-base-content/45">${escape_html(Math.round(progress || 0))}% complete</p>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--> `);
      if (detailed && download) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<p class="mt-2 text-xs text-base-content/55">${escape_html(formatBytes(download.bytes))} downloaded · ${escape_html(formatBytes(download.bytesPerSecond))}/s${escape_html(download.remainingSeconds ? ` · about ${download.remainingSeconds}s remaining` : "")}</p>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]-->`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div></div>`);
  });
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
    let detailedPlaybackProgress = false;
    let releaseChoices = [];
    let library = [];
    let progressEntries = [];
    let bulkUpdating = false;
    async function loadEpisodes(preferredEpisode = "") {
      return;
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
    function preparationTitle() {
      if (media.type === "tv" && true) return "Choose an episode to begin";
      return `Getting ${media.title || "your title"} ready…`;
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
    $$renderer2.push(`<section class="py-2 sm:py-6"><a class="link link-hover text-sm text-base-content/60" href="/">← Back to discover</a> <div class="mt-6 border-b border-base-300 pb-6 sm:flex sm:items-end sm:justify-between sm:gap-6"><div><p class="text-xs font-semibold tracking-[0.18em] text-base-content/50">${escape_html(media.type === "tv" ? "SERIES" : "FILM")}${escape_html(media.year ? ` · ${media.year}` : "")}</p><h1 class="mt-2 text-3xl font-semibold tracking-tight sm:text-5xl">${escape_html(media.title || "Watch")}</h1>`);
    if (media.type === "tv" && selectedSeason && selectedEpisode) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<p class="mt-2 text-base-content/65">Season ${escape_html(selectedSeason)}, episode ${escape_html(selectedEpisode)}</p>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div><div class="mt-4 flex flex-wrap gap-2 sm:mt-0"><button class="btn btn-sm btn-outline">${escape_html(isInLibrary() ? "Remove from library" : "+ Add to library")}</button><button class="btn btn-sm btn-ghost"${attr("disabled", media.type === "tv" && !selectedEpisode, true)}>${escape_html(isWatched() ? `Mark ${media.type === "tv" ? "episode " : ""}unwatched` : `Mark ${media.type === "tv" ? "episode " : ""}watched`)}</button></div></div> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <div${attr_class(`mt-8 grid gap-8 ${media.type === "tv" || releaseChoices.length ? "xl:grid-cols-[minmax(0,1fr)_24rem]" : ""}`)}><div>`);
    {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`<div class="aspect-video">`);
      PlaybackPreparation($$renderer2, {
        title: preparationTitle(),
        message: playback?.message,
        progress: playback?.progress,
        download: playback?.download,
        detailed: detailedPlaybackProgress,
        error: playback?.status === "error"
      });
      $$renderer2.push(`<!----></div>`);
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
      $$renderer2.push(`<aside class="border-t border-base-300 pt-6 xl:border-l xl:border-t-0 xl:pl-6 xl:pt-0">`);
      if (media.type === "tv") {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<div class="flex flex-wrap items-end justify-between gap-4"><div><h2 class="text-lg font-semibold">Episodes</h2><p class="mt-1 text-xs text-base-content/55">Select an episode to start watching</p></div> <div class="flex flex-wrap items-center justify-end gap-2"><label class="form-control w-40"><span class="sr-only">Season</span>`);
        $$renderer2.select(
          {
            class: "select select-bordered select-sm w-full",
            "aria-label": "Season",
            "aria-busy": !seasons.length && playback?.status !== "error",
            value: selectedSeason,
            disabled: !seasons.length,
            onchange: () => loadEpisodes()
          },
          ($$renderer3) => {
            if (seasons.length) {
              $$renderer3.push("<!--[0-->");
              $$renderer3.push(`<!--[-->`);
              const each_array = ensure_array_like(seasons);
              for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
                let season = each_array[$$index];
                $$renderer3.option({ value: String(season.number) }, ($$renderer4) => {
                  $$renderer4.push(`${escape_html(season.name)}`);
                });
              }
              $$renderer3.push(`<!--]-->`);
            } else {
              $$renderer3.push("<!--[-1-->");
              $$renderer3.option({ value: "" }, ($$renderer4) => {
                $$renderer4.push(`${escape_html("Loading seasons…")}`);
              });
            }
            $$renderer3.push(`<!--]-->`);
          }
        );
        $$renderer2.push(`</label> <details${attr_class("dropdown dropdown-end", void 0, { "pointer-events-none": !episodes.length || bulkUpdating })}><summary${attr_class("btn btn-sm btn-ghost", void 0, { "opacity-50": !episodes.length || bulkUpdating })}${attr("aria-disabled", !episodes.length || bulkUpdating)}>Bulk actions <span aria-hidden="true">⌄</span></summary> <ul class="menu dropdown-content z-30 mt-2 w-56 border border-base-300 bg-base-100 p-1 shadow-xl" aria-label="Bulk episode actions"><li><button>${escape_html(isSeasonWatched() ? "Mark season unwatched" : "Mark season watched")}</button></li> <li><button>${escape_html(isSeriesWatched() ? "Mark series unwatched" : "Mark series watched")}</button></li></ul></details></div></div> `);
        if (episodes.length) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<div class="mt-4 max-h-[34rem] divide-y divide-base-300 overflow-y-auto border-y border-base-300"><!--[-->`);
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
            $$renderer2.push(`<div${attr_class("group flex w-full items-center text-left transition-colors hover:bg-base-200", void 0, { "bg-base-200": String(episode.number) === selectedEpisode })}><button class="flex min-w-0 flex-1 items-center gap-4 px-2 py-4 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"${attr("aria-current", String(episode.number) === selectedEpisode ? "true" : void 0)}${attr("aria-label", `Play episode ${episode.number}, ${episode.name}`)}><span class="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-base-300 text-sm font-semibold text-base-content/65 transition-colors group-hover:border-primary group-hover:bg-primary group-hover:text-primary-content">`);
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
            $$renderer2.push(`<!--]--></span></button> <button${attr_class("mr-2 grid size-9 shrink-0 place-items-center rounded-full text-sm hover:bg-base-300 hover:text-primary focus-visible:outline-2 focus-visible:outline-primary", void 0, { "text-primary": episodeWatched })}${attr("aria-label", episodeWatched ? `Mark episode ${episode.number} unwatched` : `Mark episode ${episode.number} watched`)}${attr("aria-pressed", episodeWatched)}>${escape_html(episodeWatched ? "✓" : "○")}</button></div>`);
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
        $$renderer2.push(`<div class="mt-8 border-t border-base-300 pt-5"><p class="text-xs font-semibold tracking-[0.14em] text-base-content/55">CHOOSE A RELEASE</p><div class="mt-3 divide-y divide-base-300 border-y border-base-300"><!--[-->`);
        const each_array_3 = ensure_array_like(releaseChoices);
        for (let $$index_3 = 0, $$length = each_array_3.length; $$index_3 < $$length; $$index_3++) {
          let release = each_array_3[$$index_3];
          $$renderer2.push(`<button class="flex w-full items-start justify-between gap-3 py-3 text-left hover:text-primary"><span class="min-w-0"><span class="block truncate text-sm font-medium">${escape_html(release.title)}</span><span class="mt-1 block text-xs text-base-content/55">${escape_html(release.readiness.label)} · ${escape_html(release.category)}</span></span>`);
          if (release.size) {
            $$renderer2.push("<!--[0-->");
            $$renderer2.push(`<span class="shrink-0 text-xs text-base-content/55">${escape_html(release.size)}</span>`);
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
export {
  _page as default
};
