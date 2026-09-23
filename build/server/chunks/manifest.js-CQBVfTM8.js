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
		client: {start:"_app/immutable/entry/start.J749iLUz.js",app:"_app/immutable/entry/app.D_g4T51m.js",imports:["_app/immutable/entry/start.J749iLUz.js","_app/immutable/chunks/Dkmtt3q1.js","_app/immutable/chunks/Gv6WMrfy.js","_app/immutable/chunks/BPfEqnnS.js","_app/immutable/entry/app.D_g4T51m.js","_app/immutable/chunks/PPVm8Dsz.js","_app/immutable/chunks/Gv6WMrfy.js","_app/immutable/chunks/DsnmJJEf.js","_app/immutable/chunks/BS4-Z1ss.js","_app/immutable/chunks/8YBMLi0C.js","_app/immutable/chunks/AWJOT2b_.js"],stylesheets:[],fonts:[],uses_env_dynamic_public:false},
		nodes: [
			__memo(() => import('./nodes/0.js-WFSvm7-2.js')),
			__memo(() => import('./nodes/1.js-Ds1zrn-C.js')),
			__memo(() => import('./nodes/2.js-BdqIg5wu.js')),
			__memo(() => import('./nodes/3.js-9MluLoBe.js')),
			__memo(() => import('./nodes/4.js-BgsTHrRd.js')),
			__memo(() => import('./nodes/5.js-B8sMBHyw.js')),
			__memo(() => import('./nodes/6.js-C3CMaA_z.js'))
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
				endpoint: __memo(() => import('./entries/endpoints/api/_...path_/_server.js-CYfk5LLD.js'))
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
//# sourceMappingURL=manifest.js-CQBVfTM8.js.map
