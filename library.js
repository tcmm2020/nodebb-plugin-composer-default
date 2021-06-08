'use strict';

const url = require('url');

const nconf = require.main.require('nconf');
const winston = require.main.require('winston');
const validator = require('validator');

const plugins = require.main.require('./src/plugins');
const topics = require.main.require('./src/topics');
const categories = require.main.require('./src/categories');
const posts = require.main.require('./src/posts');
const user = require.main.require('./src/user');
const meta = require.main.require('./src/meta');
const privileges = require.main.require('./src/privileges');
const translator = require.main.require('./src/translator');
const helpers = require.main.require('./src/controllers/helpers');
const SocketPlugins = require.main.require('./src/socket.io/plugins');
const socketMethods = require('./websockets');

const plugin = module.exports;

plugin.socketMethods = socketMethods;

plugin.init = async function (data) {
	const controllers = require('./controllers');
	SocketPlugins.composer = socketMethods;

	data.router.get('/admin/plugins/composer-default', data.middleware.admin.buildHeader, controllers.renderAdminPage);
	data.router.get('/api/admin/plugins/composer-default', controllers.renderAdminPage);
};

plugin.appendConfig = async function (config) {
	config['composer-default'] = await meta.settings.get('composer-default');
	return config;
};

plugin.addAdminNavigation = async function (header) {
	header.plugins.push({
		route: '/plugins/composer-default',
		icon: 'fa-edit',
		name: 'Composer (Default)',
	});
	return header;
};

plugin.addPrefetchTags = async function (hookData) {
	const prefetch = [
		'/assets/src/modules/composer.js', '/assets/src/modules/composer/uploads.js', '/assets/src/modules/composer/drafts.js',
		'/assets/src/modules/composer/tags.js', '/assets/src/modules/composer/categoryList.js', '/assets/src/modules/composer/resize.js',
		'/assets/src/modules/composer/autocomplete.js', '/assets/templates/composer.tpl',
		'/assets/language/' + (meta.config.defaultLang || 'en-GB') + '/topic.json',
		'/assets/language/' + (meta.config.defaultLang || 'en-GB') + '/modules.json',
		'/assets/language/' + (meta.config.defaultLang || 'en-GB') + '/tags.json',
	];

	hookData.links = hookData.links.concat(prefetch.map(function (path) {
		return {
			rel: 'prefetch',
			href: nconf.get('relative_path') + path + '?' + meta.config['cache-buster'],
		};
	}));

	return hookData;
};

plugin.getFormattingOptions = async function () {
	const defaultVisibility = {
		mobile: true,
		desktop: true,

		// op or reply
		main: true,
		reply: true,
	}
	let payload = {
		defaultVisibility,
		options: [
			{ name: 'tags', title: '[[global:tags.tags]]', className: 'fa fa-tags',
				visibility: {
					...defaultVisibility,
					desktop: false,
				}
			},
			// { name: 'zen', title: '[[modules:composer.zen_mode]]', className: 'fa fa-arrows-alt', title: '[[modules:composer.zen_mode]]', visibility: defaultVisibility },
		],
	};
	// if (parseInt(meta.config.allowTopicsThumbnail, 10) === 1) {
	// 	payload.options.push({ name: 'thumbs', title: '[[topic:composer.thumb_title]]', className: 'fa fa-address-card-o',
	// 		visibility: {
	// 			...defaultVisibility,
	// 			reply: false,
	// 		},
	// 	});
	// }

	payload = await plugins.fireHook('filter:composer.formatting', payload);

	// TODO: Backwards compatibility -- remove in v1.16.0
	payload.options = payload.options.map((option) => {
		option.visibility = {
			...defaultVisibility,
			...option.visibility || {},
		}
		if (option.hasOwnProperty('mobile')) {
			winston.warn('[composer/formatting] `mobile` is no longer supported as a formatting option, use `visibility` instead (default values are passed in payload)');
			option.visibility.mobile = option.mobile;
			option.visibility.desktop = !option.mobile;
		}

		return option;
	});
	// end

	return payload ? payload.options : null;
};

plugin.filterComposerBuild = async function (hookData) {
	const req = hookData.req;
	const res = hookData.res;

	if (req.query.p) {
		if (!res.locals.isAPI) {
			var a;
			try {
				a = url.parse(req.query.p, true, true);
			} catch (e) {
				return helpers.redirect(res, '/');
			}
			return helpers.redirect(res, '/' + (a.path || '').replace(/^\/*/, ''));
		}
		res.render('', {});
		return;
	} else if (!req.query.pid && !req.query.tid && !req.query.cid) {
		return helpers.redirect(res, '/');
	}
	const [
		isMainPost,
		postData,
		topicData,
		categoryData,
		isAdmin,
		isMod,
		formatting,
		tagWhitelist,
		globalPrivileges,
		canTagTopics,
	] = await Promise.all([
		posts.isMain(req.query.pid),
		getPostData(req),
		getTopicData(req),
		categories.getCategoryFields(req.query.cid, ['minTags', 'maxTags']),
		user.isAdministrator(req.uid),
		isModerator(req),
		plugin.getFormattingOptions(),
		getTagWhitelist(req.query),
		privileges.global.get(req.uid),
		canTag(req),
	]);

	const isEditing = !!req.query.pid;
	const isGuestPost = postData && parseInt(postData.uid, 10) === 0;
	const save_id = generateSaveId(req);
	const discardRoute = generateDiscardRoute(req, topicData);
	const body = await generateBody(req, postData);

	var action = 'topics.post';
	let isMain = isMainPost;
	if (req.query.tid) {
		action = 'posts.reply';
	} else if (req.query.pid) {
		action = 'posts.edit';
	} else {
		isMain = true;
	}
	globalPrivileges['topics:tag'] = canTagTopics;
	return {
		req: req,
		res: res,
		templateData: {
			disabled: !req.query.pid && !req.query.tid && !req.query.cid,
			pid: parseInt(req.query.pid, 10),
			tid: parseInt(req.query.tid, 10),
			cid: parseInt(req.query.cid, 10) || (topicData ? topicData.cid : null),
			action: action,
			toPid: parseInt(req.query.toPid, 10),
			discardRoute: discardRoute,

			resizable: false,
			allowTopicsThumbnail: parseInt(meta.config.allowTopicsThumbnail, 10) === 1 && isMain,

			topicTitle: topicData ? topicData.title.replace(/%/g, '&#37;').replace(/,/g, '&#44;') : '',
			thumb: topicData ? topicData.thumb : '',
			body: body,

			isMain: isMain,
			isTopicOrMain: !!req.query.cid || isMain,
			minimumTagLength: meta.config.minimumTagLength || 3,
			maximumTagLength: meta.config.maximumTagLength || 15,
			tagWhitelist: tagWhitelist,
			minTags: categoryData.minTags,
			maxTags: categoryData.maxTags,

			isTopic: !!req.query.cid,
			isEditing: isEditing,
			showHandleInput: meta.config.allowGuestHandles === 1 && (req.uid === 0 || (isEditing && isGuestPost && (isAdmin || isMod))),
			handle: postData ? postData.handle || '' : undefined,
			formatting: formatting,
			isAdminOrMod: isAdmin || isMod,
			save_id: save_id,
			privileges: globalPrivileges,
		},
	};
};

function generateDiscardRoute(req, topicData) {
	if (req.query.cid) {
		return nconf.get('relative_path') + '/category/' + validator.escape(String(req.query.cid));
	} else if ((req.query.tid || req.query.pid)) {
		if (topicData) {
			return nconf.get('relative_path') + '/topic/' + topicData.slug;
		}
		return nconf.get('relative_path') + '/';
	}
}

async function generateBody(req, postData) {
	// Quoted reply
	if (req.query.toPid && parseInt(req.query.quoted, 10) === 1 && postData) {
		const username = await user.getUserField(postData.uid, 'username');
		const translated = await translator.translate('[[modules:composer.user_said, ' + username + ']]');
		return translated + '\n' +
			'> ' + (postData ? postData.content.replace(/\n/g, '\n> ') + '\n\n' : '');
	} else if (req.query.body) {
		return req.query.body;
	}
	return postData ? postData.content : '';
}

function generateSaveId(req) {
	if (req.query.cid) {
		return ['composer', req.uid, 'cid', req.query.cid].join(':');
	} else if (req.query.tid) {
		return ['composer', req.uid, 'tid', req.query.tid].join(':');
	} else if (req.query.pid) {
		return ['composer', req.uid, 'pid', req.query.pid].join(':');
	}
}

async function getPostData(req) {
	if (!req.query.pid && !req.query.toPid) {
		return null;
	}

	return await posts.getPostData(req.query.pid || req.query.toPid);
}

async function getTopicData(req) {
	if (req.query.tid) {
		return await topics.getTopicData(req.query.tid);
	} else if (req.query.pid) {
		return await topics.getTopicDataByPid(req.query.pid);
	}
	return null;
}

async function isModerator(req) {
	if (!req.loggedIn) {
		return false;
	}
	const cid = cidFromQuery(req.query);
	return await user.isModerator(req.uid, cid);
}

async function canTag(req) {
	if (parseInt(req.query.cid, 10)) {
		return await privileges.categories.can('topics:tag', req.query.cid, req.uid);
	}
	return true;
}

async function getTagWhitelist(query) {
	const cid = await cidFromQuery(query);
	const tagWhitelist = await categories.getTagWhitelist([cid]);
	return tagWhitelist[0];
}

async function cidFromQuery(query) {
	if (query.cid) {
		return query.cid;
	} else if (query.tid) {
		return await topics.getTopicField(query.tid, 'cid');
	} else if (query.pid) {
		return await posts.getCidByPid(query.pid);
	}
	return null;
}
