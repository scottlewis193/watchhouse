
// this file is generated — do not edit it


declare module "svelte/elements" {
	export interface HTMLAttributes<T> {
		'data-sveltekit-keepfocus'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-noscroll'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-preload-code'?:
			| true
			| ''
			| 'eager'
			| 'viewport'
			| 'hover'
			| 'tap'
			| 'off'
			| undefined
			| null;
		'data-sveltekit-preload-data'?: true | '' | 'hover' | 'tap' | 'off' | undefined | null;
		'data-sveltekit-reload'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-replacestate'?: true | '' | 'off' | undefined | null;
	}
}

export {};


declare module "$app/types" {
	type MatcherParam<M> = M extends (param : string) => param is (infer U extends string) ? U : string;

	export interface AppTypes {
		RouteId(): "/" | "/api" | "/api/[...path]" | "/downloads" | "/library" | "/settings" | "/watch" | "/watch/[type]" | "/watch/[type]/[id]";
		RouteParams(): {
			"/api/[...path]": { path: string };
			"/watch/[type]": { type: string };
			"/watch/[type]/[id]": { type: string; id: string }
		};
		LayoutParams(): {
			"/": { path?: string | undefined; type?: string | undefined; id?: string | undefined };
			"/api": { path?: string | undefined };
			"/api/[...path]": { path: string };
			"/downloads": Record<string, never>;
			"/library": Record<string, never>;
			"/settings": Record<string, never>;
			"/watch": { type?: string | undefined; id?: string | undefined };
			"/watch/[type]": { type: string; id?: string | undefined };
			"/watch/[type]/[id]": { type: string; id: string }
		};
		Pathname(): "/" | `/api/${string}` & {} | "/downloads" | "/library" | "/settings" | `/watch/${string}/${string}` & {};
		ResolvedPathname(): `${"" | `/${string}`}${ReturnType<AppTypes['Pathname']>}`;
		Asset(): "/apple-touch-icon.png" | "/icon-192.png" | "/icon-512.png" | "/icon-maskable-512.png" | "/icon-maskable.svg" | "/icon.svg" | "/manifest.webmanifest" | "/offline.html" | string & {};
	}
}