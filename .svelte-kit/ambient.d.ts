
// this file is generated — do not edit it


/// <reference types="@sveltejs/kit" />

/**
 * This module provides access to environment variables that are injected _statically_ into your bundle at build time and are limited to _private_ access.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Static environment variables are [loaded by Vite](https://vitejs.dev/guide/env-and-mode.html#env-files) from `.env` files and `process.env` at build time and then statically injected into your bundle at build time, enabling optimisations like dead code elimination.
 * 
 * **_Private_ access:**
 * 
 * - This module cannot be imported into client-side code
 * - This module only includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured)
 * 
 * For example, given the following build time environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { ENVIRONMENT, PUBLIC_BASE_URL } from '$env/static/private';
 * 
 * console.log(ENVIRONMENT); // => "production"
 * console.log(PUBLIC_BASE_URL); // => throws error during build
 * ```
 * 
 * The above values will be the same _even if_ different values for `ENVIRONMENT` or `PUBLIC_BASE_URL` are set at runtime, as they are statically replaced in your code with their build time values.
 */
declare module '$env/static/private' {
	export const SVELTEKIT_FORK: string;
	export const HYPRCURSOR_SIZE: string;
	export const OLDPWD: string;
	export const LC_NUMERIC: string;
	export const npm_config_global_ignore_file: string;
	export const MAIL: string;
	export const npm_package_version: string;
	export const LS_COLORS: string;
	export const HOME: string;
	export const YDOTOOL_SOCKET: string;
	export const MOTD_SHOWN: string;
	export const LC_PAPER: string;
	export const npm_command: string;
	export const LC_TELEPHONE: string;
	export const EDITOR: string;
	export const GIT_PAGER: string;
	export const CUA_DRIVER_RS_ENABLE_WAYLAND: string;
	export const FZF_DEFAULT_COMMAND: string;
	export const COLORTERM: string;
	export const npm_config_globalconfig: string;
	export const DISABLE_AUTO_UPDATE: string;
	export const XDG_MENU_PREFIX: string;
	export const _: string;
	export const LC_MEASUREMENT: string;
	export const XDG_CURRENT_DESKTOP: string;
	export const HISTCONTROL: string;
	export const npm_config_npm_version: string;
	export const XDG_DATA_HOME: string;
	export const LESS: string;
	export const npm_config_node_gyp: string;
	export const _JAVA_AWT_WM_NONREPARENTING: string;
	export const HYPRCURSOR_THEME: string;
	export const GH_PAGER: string;
	export const XDG_CONFIG_HOME: string;
	export const npm_node_execpath: string;
	export const PROMPT_COMMAND: string;
	export const XDG_SESSION_DESKTOP: string;
	export const npm_config_init_module: string;
	export const HYPRLAND_CMD: string;
	export const XDG_SEAT_PATH: string;
	export const BUN_INSTALL: string;
	export const XDG_BACKEND: string;
	export const _P9K_SSH_TTY: string;
	export const NO_COLOR: string;
	export const XDG_CONFIG_DIRS: string;
	export const ELECTRON_OZONE_PLATFORM_HINT: string;
	export const DISPLAY: string;
	export const SYSTEMD_EXEC_PID: string;
	export const LSCOLORS: string;
	export const NODE: string;
	export const TERM: string;
	export const npm_config_cache: string;
	export const XDG_SESSION_TYPE: string;
	export const npm_config_userconfig: string;
	export const LOGNAME: string;
	export const SHELL: string;
	export const MEMORY_PRESSURE_WATCH: string;
	export const XCURSOR_THEME: string;
	export const QT_QPA_PLATFORMTHEME: string;
	export const MOZ_ENABLE_WAYLAND: string;
	export const LC_NAME: string;
	export const npm_lifecycle_event: string;
	export const ZSH_TMUX_AUTOSTART: string;
	export const INVOCATION_ID: string;
	export const LC_IDENTIFICATION: string;
	export const LANG: string;
	export const HISTORY_IGNORE: string;
	export const MEMORY_PRESSURE_WRITE: string;
	export const COLOR: string;
	export const npm_package_name: string;
	export const npm_config_local_prefix: string;
	export const DESKTOP_SESSION: string;
	export const HL_INITIAL_WORKSPACE_TOKEN: string;
	export const MANAGERPID: string;
	export const NODE_ENV: string;
	export const CODEX_THREAD_ID: string;
	export const CODEX_SANDBOX_NETWORK_DISABLED: string;
	export const HYPRLAND_INSTANCE_SIGNATURE: string;
	export const DEBUGINFOD_URLS: string;
	export const XDG_SEAT: string;
	export const CODEX_APP_TOOLS_PIPE_PATH: string;
	export const INIT_CWD: string;
	export const QT_QPA_PLATFORM: string;
	export const LC_ADDRESS: string;
	export const P9K_SSH: string;
	export const EGL_PLATFORM: string;
	export const WAYLAND_DISPLAY: string;
	export const XDG_STATE_HOME: string;
	export const XCURSOR_SIZE: string;
	export const npm_lifecycle_script: string;
	export const CODEX_SHELL: string;
	export const UWSM_WAIT_VARNAMES: string;
	export const XDG_SESSION_CLASS: string;
	export const LESS_TERMCAP_me: string;
	export const LESS_TERMCAP_md: string;
	export const SHLVL: string;
	export const LC_MONETARY: string;
	export const npm_config_prefix: string;
	export const USER: string;
	export const NOTIFY_SOCKET: string;
	export const PAGER: string;
	export const XDG_VTNR: string;
	export const UWSM_FINALIZE_VARNAMES: string;
	export const ZSH: string;
	export const CODEX_MCP_NODE_PATH: string;
	export const XDG_SESSION_ID: string;
	export const MANAGERPIDFDID: string;
	export const CODEX_CI: string;
	export const XDG_CACHE_HOME: string;
	export const npm_config_user_agent: string;
	export const VSSCRIPT_PATH: string;
	export const XDG_SESSION_PATH: string;
	export const npm_execpath: string;
	export const FC_FONTATIONS: string;
	export const LC_CTYPE: string;
	export const PWD: string;
	export const LC_ALL: string;
	export const npm_package_engines_node: string;
	export const XDG_RUNTIME_DIR: string;
	export const ZSH_TMUX_AUTOSTARTED: string;
	export const FZF_BASE: string;
	export const CODEX_SESSION_ID: string;
	export const LOG_FORMAT: string;
	export const npm_package_json: string;
	export const DBUS_SESSION_BUS_ADDRESS: string;
	export const LC_TIME: string;
	export const CODEX_INTERNAL_ORIGINATOR_OVERRIDE: string;
	export const JOURNAL_STREAM: string;
	export const XDG_DATA_DIRS: string;
	export const GDK_BACKEND: string;
	export const npm_config_allow_scripts: string;
	export const npm_config_noproxy: string;
	export const BROWSER: string;
	export const PATH: string;
	export const CHROME_DESKTOP: string;
	export const npm_config_global_prefix: string;
	export const RUST_LOG: string;
}

/**
 * This module provides access to environment variables that are injected _statically_ into your bundle at build time and are _publicly_ accessible.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Static environment variables are [loaded by Vite](https://vitejs.dev/guide/env-and-mode.html#env-files) from `.env` files and `process.env` at build time and then statically injected into your bundle at build time, enabling optimisations like dead code elimination.
 * 
 * **_Public_ access:**
 * 
 * - This module _can_ be imported into client-side code
 * - **Only** variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`) are included
 * 
 * For example, given the following build time environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { ENVIRONMENT, PUBLIC_BASE_URL } from '$env/static/public';
 * 
 * console.log(ENVIRONMENT); // => throws error during build
 * console.log(PUBLIC_BASE_URL); // => "http://site.com"
 * ```
 * 
 * The above values will be the same _even if_ different values for `ENVIRONMENT` or `PUBLIC_BASE_URL` are set at runtime, as they are statically replaced in your code with their build time values.
 */
declare module '$env/static/public' {
	
}

/**
 * This module provides access to environment variables set _dynamically_ at runtime and that are limited to _private_ access.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Dynamic environment variables are defined by the platform you're running on. For example if you're using [`adapter-node`](https://github.com/sveltejs/kit/tree/main/packages/adapter-node) (or running [`vite preview`](https://svelte.dev/docs/kit/cli)), this is equivalent to `process.env`.
 * 
 * **_Private_ access:**
 * 
 * - This module cannot be imported into client-side code
 * - This module includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured)
 * 
 * > [!NOTE] In `dev`, `$env/dynamic` includes environment variables from `.env`. In `prod`, this behavior will depend on your adapter.
 * 
 * > [!NOTE] To get correct types, environment variables referenced in your code should be declared (for example in an `.env` file), even if they don't have a value until the app is deployed:
 * >
 * > ```env
 * > MY_FEATURE_FLAG=
 * > ```
 * >
 * > You can override `.env` values from the command line like so:
 * >
 * > ```sh
 * > MY_FEATURE_FLAG="enabled" npm run dev
 * > ```
 * 
 * For example, given the following runtime environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { env } from '$env/dynamic/private';
 * 
 * console.log(env.ENVIRONMENT); // => "production"
 * console.log(env.PUBLIC_BASE_URL); // => undefined
 * ```
 */
declare module '$env/dynamic/private' {
	export const env: {
		SVELTEKIT_FORK: string;
		HYPRCURSOR_SIZE: string;
		OLDPWD: string;
		LC_NUMERIC: string;
		npm_config_global_ignore_file: string;
		MAIL: string;
		npm_package_version: string;
		LS_COLORS: string;
		HOME: string;
		YDOTOOL_SOCKET: string;
		MOTD_SHOWN: string;
		LC_PAPER: string;
		npm_command: string;
		LC_TELEPHONE: string;
		EDITOR: string;
		GIT_PAGER: string;
		CUA_DRIVER_RS_ENABLE_WAYLAND: string;
		FZF_DEFAULT_COMMAND: string;
		COLORTERM: string;
		npm_config_globalconfig: string;
		DISABLE_AUTO_UPDATE: string;
		XDG_MENU_PREFIX: string;
		_: string;
		LC_MEASUREMENT: string;
		XDG_CURRENT_DESKTOP: string;
		HISTCONTROL: string;
		npm_config_npm_version: string;
		XDG_DATA_HOME: string;
		LESS: string;
		npm_config_node_gyp: string;
		_JAVA_AWT_WM_NONREPARENTING: string;
		HYPRCURSOR_THEME: string;
		GH_PAGER: string;
		XDG_CONFIG_HOME: string;
		npm_node_execpath: string;
		PROMPT_COMMAND: string;
		XDG_SESSION_DESKTOP: string;
		npm_config_init_module: string;
		HYPRLAND_CMD: string;
		XDG_SEAT_PATH: string;
		BUN_INSTALL: string;
		XDG_BACKEND: string;
		_P9K_SSH_TTY: string;
		NO_COLOR: string;
		XDG_CONFIG_DIRS: string;
		ELECTRON_OZONE_PLATFORM_HINT: string;
		DISPLAY: string;
		SYSTEMD_EXEC_PID: string;
		LSCOLORS: string;
		NODE: string;
		TERM: string;
		npm_config_cache: string;
		XDG_SESSION_TYPE: string;
		npm_config_userconfig: string;
		LOGNAME: string;
		SHELL: string;
		MEMORY_PRESSURE_WATCH: string;
		XCURSOR_THEME: string;
		QT_QPA_PLATFORMTHEME: string;
		MOZ_ENABLE_WAYLAND: string;
		LC_NAME: string;
		npm_lifecycle_event: string;
		ZSH_TMUX_AUTOSTART: string;
		INVOCATION_ID: string;
		LC_IDENTIFICATION: string;
		LANG: string;
		HISTORY_IGNORE: string;
		MEMORY_PRESSURE_WRITE: string;
		COLOR: string;
		npm_package_name: string;
		npm_config_local_prefix: string;
		DESKTOP_SESSION: string;
		HL_INITIAL_WORKSPACE_TOKEN: string;
		MANAGERPID: string;
		NODE_ENV: string;
		CODEX_THREAD_ID: string;
		CODEX_SANDBOX_NETWORK_DISABLED: string;
		HYPRLAND_INSTANCE_SIGNATURE: string;
		DEBUGINFOD_URLS: string;
		XDG_SEAT: string;
		CODEX_APP_TOOLS_PIPE_PATH: string;
		INIT_CWD: string;
		QT_QPA_PLATFORM: string;
		LC_ADDRESS: string;
		P9K_SSH: string;
		EGL_PLATFORM: string;
		WAYLAND_DISPLAY: string;
		XDG_STATE_HOME: string;
		XCURSOR_SIZE: string;
		npm_lifecycle_script: string;
		CODEX_SHELL: string;
		UWSM_WAIT_VARNAMES: string;
		XDG_SESSION_CLASS: string;
		LESS_TERMCAP_me: string;
		LESS_TERMCAP_md: string;
		SHLVL: string;
		LC_MONETARY: string;
		npm_config_prefix: string;
		USER: string;
		NOTIFY_SOCKET: string;
		PAGER: string;
		XDG_VTNR: string;
		UWSM_FINALIZE_VARNAMES: string;
		ZSH: string;
		CODEX_MCP_NODE_PATH: string;
		XDG_SESSION_ID: string;
		MANAGERPIDFDID: string;
		CODEX_CI: string;
		XDG_CACHE_HOME: string;
		npm_config_user_agent: string;
		VSSCRIPT_PATH: string;
		XDG_SESSION_PATH: string;
		npm_execpath: string;
		FC_FONTATIONS: string;
		LC_CTYPE: string;
		PWD: string;
		LC_ALL: string;
		npm_package_engines_node: string;
		XDG_RUNTIME_DIR: string;
		ZSH_TMUX_AUTOSTARTED: string;
		FZF_BASE: string;
		CODEX_SESSION_ID: string;
		LOG_FORMAT: string;
		npm_package_json: string;
		DBUS_SESSION_BUS_ADDRESS: string;
		LC_TIME: string;
		CODEX_INTERNAL_ORIGINATOR_OVERRIDE: string;
		JOURNAL_STREAM: string;
		XDG_DATA_DIRS: string;
		GDK_BACKEND: string;
		npm_config_allow_scripts: string;
		npm_config_noproxy: string;
		BROWSER: string;
		PATH: string;
		CHROME_DESKTOP: string;
		npm_config_global_prefix: string;
		RUST_LOG: string;
		[key: `PUBLIC_${string}`]: undefined;
		[key: `${string}`]: string | undefined;
	}
}

/**
 * This module provides access to environment variables set _dynamically_ at runtime and that are _publicly_ accessible.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Dynamic environment variables are defined by the platform you're running on. For example if you're using [`adapter-node`](https://github.com/sveltejs/kit/tree/main/packages/adapter-node) (or running [`vite preview`](https://svelte.dev/docs/kit/cli)), this is equivalent to `process.env`.
 * 
 * **_Public_ access:**
 * 
 * - This module _can_ be imported into client-side code
 * - **Only** variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`) are included
 * 
 * > [!NOTE] In `dev`, `$env/dynamic` includes environment variables from `.env`. In `prod`, this behavior will depend on your adapter.
 * 
 * > [!NOTE] To get correct types, environment variables referenced in your code should be declared (for example in an `.env` file), even if they don't have a value until the app is deployed:
 * >
 * > ```env
 * > MY_FEATURE_FLAG=
 * > ```
 * >
 * > You can override `.env` values from the command line like so:
 * >
 * > ```sh
 * > MY_FEATURE_FLAG="enabled" npm run dev
 * > ```
 * 
 * For example, given the following runtime environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://example.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { env } from '$env/dynamic/public';
 * console.log(env.ENVIRONMENT); // => undefined, not public
 * console.log(env.PUBLIC_BASE_URL); // => "http://example.com"
 * ```
 * 
 * ```
 * 
 * ```
 */
declare module '$env/dynamic/public' {
	export const env: {
		[key: `PUBLIC_${string}`]: string | undefined;
	}
}
