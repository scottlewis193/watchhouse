const manifest = (() => {
function __memo(fn) {
	let value;
	return () => value ??= (value = fn());
}

return {
	appDir: "_app",
	appPath: "_app",
	assets: new Set(["apple-touch-icon.png","icon-192.png","icon-512.png","icon-maskable-512.png","icon-maskable.svg","icon.svg","manifest.webmanifest","offline.html","service-worker.js"]),
	mimeTypes: {".png":"image/png",".svg":"image/svg+xml",".webmanifest":"application/manifest+json",".html":"text/html"},
	_: {
		client: {start:"_app/immutable/entry/start.DsJXVId2.js",app:"_app/immutable/entry/app.VMByKu-F.js",imports:["_app/immutable/entry/start.DsJXVId2.js","_app/immutable/chunks/CDzUdlB7.js","_app/immutable/chunks/CpiyEXbq.js","_app/immutable/chunks/BUSwY035.js","_app/immutable/entry/app.VMByKu-F.js","_app/immutable/chunks/CpiyEXbq.js","_app/immutable/chunks/BbCXg4Fj.js","_app/immutable/chunks/BX0oTeku.js","_app/immutable/chunks/CNYdJIAm.js","_app/immutable/chunks/Bhe9bDii.js","_app/immutable/chunks/UPX-SHYT.js"],stylesheets:[],fonts:[],uses_env_dynamic_public:false},
		nodes: [
			__memo(() => import('./nodes/0.js-BllbA_NB.js')),
			__memo(() => import('./nodes/1.js-GWmyzVvm.js')),
			__memo(() => import('./nodes/2.js-DIaNL4n7.js')),
			__memo(() => import('./nodes/3.js-DtD6Rx3p.js')),
			__memo(() => import('./nodes/4.js-vcGHda-A.js')),
			__memo(() => import('./nodes/5.js-BLgHn9PX.js')),
			__memo(() => import('./nodes/6.js-BwNmW10q.js'))
		],
		remotes: {
			
		},
		routes: [
			{
				id: "/",
				pattern: /^\/$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 2 },
				endpoint: null
			},
			{
				id: "/api/[...path]",
				pattern: /^\/api(?:\/([^]*))?\/?$/,
				params: [{"name":"path","optional":false,"rest":true,"chained":true}],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/api/_...path_/_server.js-BhR0WR32.js'))
			},
			{
				id: "/downloads",
				pattern: /^\/downloads\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 3 },
				endpoint: null
			},
			{
				id: "/library",
				pattern: /^\/library\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 4 },
				endpoint: null
			},
			{
				id: "/settings",
				pattern: /^\/settings\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 5 },
				endpoint: null
			},
			{
				id: "/watch/[type]/[id]",
				pattern: /^\/watch\/([^/]+?)\/([^/]+?)\/?$/,
				params: [{"name":"type","optional":false,"rest":false,"chained":false},{"name":"id","optional":false,"rest":false,"chained":false}],
				page: { layouts: [0,], errors: [1,], leaf: 6 },
				endpoint: null
			}
		],
		prerendered_routes: new Set([]),
		matchers: async () => {
			
			return {  };
		},
		server_assets: {}
	}
}
})();

export { manifest as m };
//# sourceMappingURL=manifest.js-KhB8bwsM.js.map
