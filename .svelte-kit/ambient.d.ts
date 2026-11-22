
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
	export const npm_command: string;
	export const LSCOLORS: string;
	export const npm_config_yes: string;
	export const npm_config_userconfig: string;
	export const COLORTERM: string;
	export const HYPRLAND_CMD: string;
	export const XDG_CONFIG_DIRS: string;
	export const npm_config_cache: string;
	export const PYTHONUNBUFFERED: string;
	export const PIP_NO_INPUT: string;
	export const LESS: string;
	export const XDG_SESSION_PATH: string;
	export const HISTCONTROL: string;
	export const XDG_MENU_PREFIX: string;
	export const COMPOSER_NO_INTERACTION: string;
	export const XDG_BACKEND: string;
	export const OMPCODE: string;
	export const TF_IN_AUTOMATION: string;
	export const PNPM_UPDATE_NOTIFIER: string;
	export const CUA_DRIVER_RS_ENABLE_WAYLAND: string;
	export const _P9K_TTY: string;
	export const NODE: string;
	export const VSSCRIPT_PATH: string;
	export const GLAB_PAGER: string;
	export const LC_ADDRESS: string;
	export const LC_NAME: string;
	export const PI_TERMINAL_OWNER_PID: string;
	export const XDG_DATA_HOME: string;
	export const CLOUDSDK_CORE_DISABLE_PROMPTS: string;
	export const P9K_TTY: string;
	export const XDG_CONFIG_HOME: string;
	export const AGENT: string;
	export const MEMORY_PRESSURE_WRITE: string;
	export const COLOR: string;
	export const npm_config_local_prefix: string;
	export const PI_SESSION_FILE: string;
	export const DESKTOP_SESSION: string;
	export const LC_MONETARY: string;
	export const ELECTRON_OZONE_PLATFORM_HINT: string;
	export const KITTY_PID: string;
	export const HL_INITIAL_WORKSPACE_TOKEN: string;
	export const npm_config_globalconfig: string;
	export const XCURSOR_SIZE: string;
	export const GPG_TTY: string;
	export const EDITOR: string;
	export const GH_PAGER: string;
	export const XDG_SEAT: string;
	export const GH_PROMPT_DISABLED: string;
	export const PWD: string;
	export const XDG_SESSION_DESKTOP: string;
	export const LOGNAME: string;
	export const QT_QPA_PLATFORMTHEME: string;
	export const XDG_SESSION_TYPE: string;
	export const GIT_SEQUENCE_EDITOR: string;
	export const npm_config_init_module: string;
	export const SYSTEMD_EXEC_PID: string;
	export const _: string;
	export const KITTY_PUBLIC_KEY: string;
	export const FZF_DEFAULT_COMMAND: string;
	export const CLAUDECODE: string;
	export const MOTD_SHOWN: string;
	export const YDOTOOL_SOCKET: string;
	export const HOME: string;
	export const __PI_NATIVE_VARIANT_CACHE: string;
	export const DELTA_PAGER: string;
	export const SSH_ASKPASS: string;
	export const LC_PAPER: string;
	export const LANG: string;
	export const _JAVA_AWT_WM_NONREPARENTING: string;
	export const LS_COLORS: string;
	export const XDG_CURRENT_DESKTOP: string;
	export const npm_package_version: string;
	export const MEMORY_PRESSURE_WATCH: string;
	export const WAYLAND_DISPLAY: string;
	export const AWS_PAGER: string;
	export const KITTY_WINDOW_ID: string;
	export const YARN_ENABLE_PROGRESS_BARS: string;
	export const PROMPT_COMMAND: string;
	export const XDG_SEAT_PATH: string;
	export const INVOCATION_ID: string;
	export const MANAGERPID: string;
	export const INIT_CWD: string;
	export const UWSM_WAIT_VARNAMES: string;
	export const QT_QPA_PLATFORM: string;
	export const XDG_CACHE_HOME: string;
	export const PSQL_PAGER: string;
	export const npm_lifecycle_script: string;
	export const npm_config_npm_version: string;
	export const XDG_SESSION_CLASS: string;
	export const TERMINFO: string;
	export const TERM: string;
	export const LC_IDENTIFICATION: string;
	export const npm_package_name: string;
	export const ZSH: string;
	export const LESS_TERMCAP_me: string;
	export const BAT_PAGER: string;
	export const LESS_TERMCAP_md: string;
	export const npm_config_prefix: string;
	export const USER: string;
	export const YARN_ENABLE_TELEMETRY: string;
	export const GIT_PAGER: string;
	export const PIP_DISABLE_PIP_VERSION_CHECK: string;
	export const HYPRLAND_INSTANCE_SIGNATURE: string;
	export const MANPAGER: string;
	export const VISUAL: string;
	export const NOTIFY_SOCKET: string;
	export const PI_SESSION_ID: string;
	export const DISPLAY: string;
	export const npm_lifecycle_event: string;
	export const SHLVL: string;
	export const MOZ_ENABLE_WAYLAND: string;
	export const GIT_EDITOR: string;
	export const PAGER: string;
	export const LC_TELEPHONE: string;
	export const npm_config_fund: string;
	export const SYSTEMD_PAGER: string;
	export const _P9K_SSH_TTY: string;
	export const LC_MEASUREMENT: string;
	export const XDG_VTNR: string;
	export const PI_TOOL_CALL_ID: string;
	export const XDG_SESSION_ID: string;
	export const MANAGERPIDFDID: string;
	export const npm_config_user_agent: string;
	export const NO_COLOR: string;
	export const TF_INPUT: string;
	export const XDG_STATE_HOME: string;
	export const npm_execpath: string;
	export const npm_config_progress: string;
	export const XDG_RUNTIME_DIR: string;
	export const MYSQL_PAGER: string;
	export const HOMEBREW_PAGER: string;
	export const PNPM_DISABLE_SELF_UPDATE_CHECK: string;
	export const FZF_BASE: string;
	export const DEBUGINFOD_URLS: string;
	export const npm_package_json: string;
	export const LC_TIME: string;
	export const BUN_INSTALL: string;
	export const P9K_SSH: string;
	export const HISTORY_IGNORE: string;
	export const GCM_INTERACTIVE: string;
	export const LC_ALL: string;
	export const HYPRCURSOR_THEME: string;
	export const JOURNAL_STREAM: string;
	export const CARGO_TERM_PROGRESS_WHEN: string;
	export const XCURSOR_THEME: string;
	export const XDG_DATA_DIRS: string;
	export const npm_config_noproxy: string;
	export const BROWSER: string;
	export const PATH: string;
	export const npm_config_node_gyp: string;
	export const CI: string;
	export const DBUS_SESSION_BUS_ADDRESS: string;
	export const npm_config_global_prefix: string;
	export const npm_config_update_notifier: string;
	export const MAIL: string;
	export const UWSM_FINALIZE_VARNAMES: string;
	export const npm_config_global_ignore_file: string;
	export const npm_config_audit: string;
	export const DEBIAN_FRONTEND: string;
	export const GIT_TERMINAL_PROMPT: string;
	export const KITTY_INSTALLATION_DIR: string;
	export const npm_node_execpath: string;
	export const LC_NUMERIC: string;
	export const HYPRCURSOR_SIZE: string;
	export const npm_package_engines_node: string;
	export const NODE_ENV: string;
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
		npm_command: string;
		LSCOLORS: string;
		npm_config_yes: string;
		npm_config_userconfig: string;
		COLORTERM: string;
		HYPRLAND_CMD: string;
		XDG_CONFIG_DIRS: string;
		npm_config_cache: string;
		PYTHONUNBUFFERED: string;
		PIP_NO_INPUT: string;
		LESS: string;
		XDG_SESSION_PATH: string;
		HISTCONTROL: string;
		XDG_MENU_PREFIX: string;
		COMPOSER_NO_INTERACTION: string;
		XDG_BACKEND: string;
		OMPCODE: string;
		TF_IN_AUTOMATION: string;
		PNPM_UPDATE_NOTIFIER: string;
		CUA_DRIVER_RS_ENABLE_WAYLAND: string;
		_P9K_TTY: string;
		NODE: string;
		VSSCRIPT_PATH: string;
		GLAB_PAGER: string;
		LC_ADDRESS: string;
		LC_NAME: string;
		PI_TERMINAL_OWNER_PID: string;
		XDG_DATA_HOME: string;
		CLOUDSDK_CORE_DISABLE_PROMPTS: string;
		P9K_TTY: string;
		XDG_CONFIG_HOME: string;
		AGENT: string;
		MEMORY_PRESSURE_WRITE: string;
		COLOR: string;
		npm_config_local_prefix: string;
		PI_SESSION_FILE: string;
		DESKTOP_SESSION: string;
		LC_MONETARY: string;
		ELECTRON_OZONE_PLATFORM_HINT: string;
		KITTY_PID: string;
		HL_INITIAL_WORKSPACE_TOKEN: string;
		npm_config_globalconfig: string;
		XCURSOR_SIZE: string;
		GPG_TTY: string;
		EDITOR: string;
		GH_PAGER: string;
		XDG_SEAT: string;
		GH_PROMPT_DISABLED: string;
		PWD: string;
		XDG_SESSION_DESKTOP: string;
		LOGNAME: string;
		QT_QPA_PLATFORMTHEME: string;
		XDG_SESSION_TYPE: string;
		GIT_SEQUENCE_EDITOR: string;
		npm_config_init_module: string;
		SYSTEMD_EXEC_PID: string;
		_: string;
		KITTY_PUBLIC_KEY: string;
		FZF_DEFAULT_COMMAND: string;
		CLAUDECODE: string;
		MOTD_SHOWN: string;
		YDOTOOL_SOCKET: string;
		HOME: string;
		__PI_NATIVE_VARIANT_CACHE: string;
		DELTA_PAGER: string;
		SSH_ASKPASS: string;
		LC_PAPER: string;
		LANG: string;
		_JAVA_AWT_WM_NONREPARENTING: string;
		LS_COLORS: string;
		XDG_CURRENT_DESKTOP: string;
		npm_package_version: string;
		MEMORY_PRESSURE_WATCH: string;
		WAYLAND_DISPLAY: string;
		AWS_PAGER: string;
		KITTY_WINDOW_ID: string;
		YARN_ENABLE_PROGRESS_BARS: string;
		PROMPT_COMMAND: string;
		XDG_SEAT_PATH: string;
		INVOCATION_ID: string;
		MANAGERPID: string;
		INIT_CWD: string;
		UWSM_WAIT_VARNAMES: string;
		QT_QPA_PLATFORM: string;
		XDG_CACHE_HOME: string;
		PSQL_PAGER: string;
		npm_lifecycle_script: string;
		npm_config_npm_version: string;
		XDG_SESSION_CLASS: string;
		TERMINFO: string;
		TERM: string;
		LC_IDENTIFICATION: string;
		npm_package_name: string;
		ZSH: string;
		LESS_TERMCAP_me: string;
		BAT_PAGER: string;
		LESS_TERMCAP_md: string;
		npm_config_prefix: string;
		USER: string;
		YARN_ENABLE_TELEMETRY: string;
		GIT_PAGER: string;
		PIP_DISABLE_PIP_VERSION_CHECK: string;
		HYPRLAND_INSTANCE_SIGNATURE: string;
		MANPAGER: string;
		VISUAL: string;
		NOTIFY_SOCKET: string;
		PI_SESSION_ID: string;
		DISPLAY: string;
		npm_lifecycle_event: string;
		SHLVL: string;
		MOZ_ENABLE_WAYLAND: string;
		GIT_EDITOR: string;
		PAGER: string;
		LC_TELEPHONE: string;
		npm_config_fund: string;
		SYSTEMD_PAGER: string;
		_P9K_SSH_TTY: string;
		LC_MEASUREMENT: string;
		XDG_VTNR: string;
		PI_TOOL_CALL_ID: string;
		XDG_SESSION_ID: string;
		MANAGERPIDFDID: string;
		npm_config_user_agent: string;
		NO_COLOR: string;
		TF_INPUT: string;
		XDG_STATE_HOME: string;
		npm_execpath: string;
		npm_config_progress: string;
		XDG_RUNTIME_DIR: string;
		MYSQL_PAGER: string;
		HOMEBREW_PAGER: string;
		PNPM_DISABLE_SELF_UPDATE_CHECK: string;
		FZF_BASE: string;
		DEBUGINFOD_URLS: string;
		npm_package_json: string;
		LC_TIME: string;
		BUN_INSTALL: string;
		P9K_SSH: string;
		HISTORY_IGNORE: string;
		GCM_INTERACTIVE: string;
		LC_ALL: string;
		HYPRCURSOR_THEME: string;
		JOURNAL_STREAM: string;
		CARGO_TERM_PROGRESS_WHEN: string;
		XCURSOR_THEME: string;
		XDG_DATA_DIRS: string;
		npm_config_noproxy: string;
		BROWSER: string;
		PATH: string;
		npm_config_node_gyp: string;
		CI: string;
		DBUS_SESSION_BUS_ADDRESS: string;
		npm_config_global_prefix: string;
		npm_config_update_notifier: string;
		MAIL: string;
		UWSM_FINALIZE_VARNAMES: string;
		npm_config_global_ignore_file: string;
		npm_config_audit: string;
		DEBIAN_FRONTEND: string;
		GIT_TERMINAL_PROMPT: string;
		KITTY_INSTALLATION_DIR: string;
		npm_node_execpath: string;
		LC_NUMERIC: string;
		HYPRCURSOR_SIZE: string;
		npm_package_engines_node: string;
		NODE_ENV: string;
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
