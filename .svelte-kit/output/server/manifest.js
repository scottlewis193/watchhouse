export const manifest = (() => {
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
		client: {start:"_app/immutable/entry/start.D35j3Y2n.js",app:"_app/immutable/entry/app.CfA1XA5F.js",imports:["_app/immutable/entry/start.D35j3Y2n.js","_app/immutable/chunks/D0B86qvZ.js","_app/immutable/chunks/I_H_Rd4f.js","_app/immutable/chunks/BL3buyXI.js","_app/immutable/entry/app.CfA1XA5F.js","_app/immutable/chunks/PPVm8Dsz.js","_app/immutable/chunks/I_H_Rd4f.js","_app/immutable/chunks/Qte-gN6Z.js","_app/immutable/chunks/D6ltY_dz.js","_app/immutable/chunks/BkRVOT8N.js","_app/immutable/chunks/BQB5adtB.js","_app/immutable/chunks/D-QD7IC6.js"],stylesheets:[],fonts:[],uses_env_dynamic_public:false},
		nodes: [
			__memo(() => import('./nodes/0.js')),
			__memo(() => import('./nodes/1.js')),
			__memo(() => import('./nodes/2.js')),
			__memo(() => import('./nodes/3.js')),
			__memo(() => import('./nodes/4.js')),
			__memo(() => import('./nodes/5.js')),
			__memo(() => import('./nodes/6.js'))
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
				endpoint: __memo(() => import('./entries/endpoints/api/_...path_/_server.js'))
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
