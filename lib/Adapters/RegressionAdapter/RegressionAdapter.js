
var Q = require('q');
var _ = require('underscore');
var config = require('../../../common/Configuration');
var BaseAdapter=require('./../BaseAdapter.js').BaseAdapter;
var StreamInfo=require('./../BaseAdapter.js').StreamInfo;
var WowzaStreamInfo=require('./../WowzaStreamInfo.js');
var util=require('util');
var url=require('url');
var http=require('http');
var fs=require('fs');
var networkClient = require('./../../NetworkClientFactory').getNetworkClient();
var promUtils = require('../../utils/promise-utils');
var m3u8Handler = require('../../manifest/promise-m3u8');
var m3u8 = require('m3u8');
var m3u = require('m3u');
var fs_utils = require('../../utils/fs-utils');
var basePath=__dirname + "/../../tests/resources/liveSessionData/";
var logger = require('../../../common/logger')
var validator = require('./hlsStreamRegressionValidator');
var ErrorUtils = require('../../utils/error-utils');
const qio = require('q-io/fs');
const globfs = require('glob-fs')({ gitignore: true });

var weblogger = logger.getLogger("RegressionAdapter-Web");
var regressionAdapterConfig = config.get('regressionAdapter');
var mediaServer = config.get('mediaServer');
var entriesInfo = config.get('regressionAdapter').entries;
var applicationName = mediaServer.applicationName;
var hostname = mediaServer.hostname;
var port = mediaServer.port;

var testHelper;

if (!regressionAdapterConfig || !regressionAdapterConfig.enable) {
    return;
}


function readFile(res, full_path_file, entryId) {
    fs.readFile(full_path_file, function (err, data) {
        if (err) {
            res.writeHead(404);
            res.end(JSON.stringify(err));
            testHelper.logger.error('[%s] failed to read path=%s. Error: %s', entryId, full_path_file, ErrorUtils.error2string(err));
        }
        res.writeHead(200);
        res.end(data);
    });
}


function EntryInfo(entryId, first_chunklist_index) {

    this.id = entryId;
    this.chunklist_index = {};
    this.playlist = {};
    this.read = {};
    this.playlist_initialized = false;
    this.initial_chunklist_index = first_chunklist_index;
    this.last_chunklist_index = -1;
    this.chunklist_count = 0;
    this.data_warehouse_path = 'undefined';
}


function TestHelper() {

    this.rootFolderPath =  regressionAdapterConfig['dataWarehouseRootFolderPath'] ;
    this.entries = {};
    this.logger = logger.getLogger('regressionAdapter');
    this.validators = {};
}

TestHelper.prototype.getFullLiveUrl  = function (entryId, flavor) {
    var path = '/' + applicationName + "/_definst_/" + entryId + "_" + flavor + "/";
    return url.format({
        protocol : 'http',
        hostname : hostname,
        port : port,
        pathname : path
    });
}

TestHelper.prototype.initEntries = function() {

    var that = this;
    var root_mp4_path = config.get('rootFolderPath');
    var p;
    p = _.map(entriesInfo, function (entryConfig) {
        // remove directory
        var fullpath = root_mp4_path + '/' + entryConfig.entryId;
        return fs_utils.cleanFolder(fullpath, 'obsolete').then(function () {
            that.logger.debug('[%s] CLEANUP SUCCEEDED @@@@ removed content of path=%s', entryConfig.entryId, fullpath)

            var flavors = entryConfig.flavorParamsIds.split(',');
            that.entries[entryConfig.entryId] = new EntryInfo(entryConfig.entryId, entryConfig.firstChunklistIndex);
            that.entries[entryConfig.entryId].data_warehouse_path = that.rootFolderPath + '/' + entryConfig.entryPath + '/' + entryConfig.entryId + '/' + flavors[0];

            return that.getLastChunklistFileIndex(entryConfig.entryId, that.entries[entryConfig.entryId].data_warehouse_path)
                .then(function (last_chunklist_index) {
                    that.entries[entryConfig.entryId].last_chunklist_index = last_chunklist_index;
                    that.validators[entryConfig.entryId] = new validator(entryConfig.entryId, flavors, that.entries[entryConfig.entryId].last_chunklist_index, entryConfig.validator);
                })
                .then(function() {
                    return that.validators[entryConfig.entryId].init();
                })
                .then(function () {
                    _.each(flavors, function (id) {
                        that.entries[entryConfig.entryId].chunklist_index[id] = entryConfig.firstChunklistIndex;
                        that.entries[entryConfig.entryId].read[id] = false;
                    });
                });
        }).catch(function (err) {
            that.logger.error('[%s] initialization failed. Error: %s', entryConfig.entryId, ErrorUtils.error2string(err));
        });
    });
    return Q.all(p);
}

TestHelper.prototype.initPlaylist = function() {

    this.logger.debug("TestHelper initialization");

    var that = this;

    var p=_.map(entriesInfo, function(entryConfig) {
       
        var mediaServerPlaylistUrl = that.getFullLiveUrl(entryConfig.entryId, 'all');
        var fullUrl = url.resolve(mediaServerPlaylistUrl, 'playlist.m3u8');

        // read and parse the playlist and assemble playlist per flavor
        return networkClient.read(fullUrl)
            .then(function (content) {
                that.initPlaylistPerFlavor(entryConfig.entryId, content);
            })
            .catch(function (err) {
                that.logger.warn('Initialization of entryId failed with error %s. Failed to prepare playlist per flavor.', ErrorUtils.error2string(err));
            });
    });
    return Q.all(p);

}

TestHelper.prototype.initPlaylistPerFlavor = function (entryId, all_playlist) {

    var that = this;

    return m3u8Handler.parseM3U8(all_playlist, {'verbatim': true})
        .then(function (m3u8) {
            // build playlist per flavor
            _.each(m3u8.items.StreamItem, function (item) {

                var id = item.get('uri').split('/')[0];
                var writer = m3u.httpLiveStreamingWriter();

                // Adds a playlist as the next item preceeded by an EXT-X-STREAM-INF tag.
                writer.playlist('playlist.m3u8', {
                    bandwidth: item.get('bandwidth'), // required
                    uri: item.get('uri'),
                    resolution: item.get('resolution')[0] + 'x' + item.get('resolution')[1],
                });

                that.entries[entryId].playlist[id] = writer.toString();
            });
        })
        .then( function() {
            that.entries[entryId].playlist_initialized = true;
        })
        . catch( function(err) {
           that.logger.error('Failed to parse playlist content. Error = %s', ErrorUtils.error2string(err));
        });
}

TestHelper.prototype.getPlaylist = function(entryId, flavorId) {

    var playlist = '';

    if (!this.entries[entryId].read[flavorId]) {
        this.entries[entryId].read[flavorId] = true;
        playlist =  this.entries[entryId].playlist[flavorId];
    }
    else {
        logger.error('[%s-%s] bug in RegressionAdapter, trying to get master playlist more than once.', entryId, flavorId);
    }

    return playlist;
}

TestHelper.prototype.getLastChunklistFileIndex = function (entryId, fullPath) {

    var that = this;
    var re = '([^\/]*)$';

    return globfs.readdirPromise(fullPath)
        .then (function(files) {
            last_chunklist_index = _.reduce(files, function (index, next_file) {
                var regExp = new RegExp(re);
                var new_index = regExp.exec(next_file)[0].split('_')[0];
                new_index = !isNaN(new_index) ? parseInt(new_index) : 0;
                return (next_file.endsWith('m3u8') && new_index > index ? new_index : index);
            }, 0);
            return Q.resolve(last_chunklist_index);
            that.logger.debug('[%s] last checuklist index is %s', entryId, last_chunklist_index);
        })
        .catch(function (err) {
            that.logger.debug('[%s] failed to read checuklist files from data warehouse, %s. Error: %s', entryId, fullPath, ErrorUtils.error2string(err));
        });

}


TestHelper.prototype.nextChunklist = function (entryId, flavorId) {

    if (this.isMinFlavor(entryId, flavorId)) {

        this.entries[entryId].chunklist_index[flavorId]++
    }

    return ("00000" + this.entries[entryId].chunklist_index[flavorId] ).slice(-6) + '_chunklist.m3u8';
}

TestHelper.prototype.readyToValidateChunklist = function(entryId, index) {

    var that = this;

    var p=_.map(this.entries[entryId].chunklist_index, function(chunklist_index) {
        if (chunklist_index > index) {
            return Q.resolve();
        }
        return Q.reject('flavor index under requirement');
    });

    return Q.all(p);
}

TestHelper.prototype.isMinFlavor = function (entryId, flavorId) {

    var min = _.min(this.entries[entryId].chunklist_index);

    return (min === this.entries[entryId].chunklist_index[flavorId]);
}

TestHelper.prototype.prevChunklist = function (entryId, flavorId) {

    return ("00000" + (_.max([this.entries[entryId].chunklist_index[flavorId]-1,10])) ).slice(-6) + '_chunklist.m3u8';
}

TestHelper.prototype.validateFlavor = function (entryId, flavorId) {
    
    var that = this;
    var finished_regression_test = false;
    
    var index = this.entries[entryId].chunklist_index[flavorId] - 1;
    
    if (index <= this.entries[entryId].initial_chunklist_index) {
        this.logger.debug('[%s] validate skipped for too low chunklist index %s', entryId, index);
        return Q.resolve();
    }

    return this.readyToValidateChunklist(entryId, index)
        .then( function() {
            // var chunklist_url = this.prevChunklist(entryId, flavorId);
            // http://localhost:8080/kLive\/smil:(.*)_all.smil\/(.*)\/chunklist.m3u8
            var url = util.format("http://localhost:8080/kLive/smil:%s_all.smil/%s/chunklist.m3u8", entryId, flavorId);
            return networkClient.read({url: url, timeout: 10000})
                .then(function (content) {
                    return that.validators[entryId].addChunklist(content, flavorId, index, url);
                })
                .then(function(m3u8) {
                    that.logger.warn('[%s-%s] **** SUCCESSFULLY VALIDATED ****  obj=[%s], url=[%s]', entryId, flavorId, m3u8, url);
                })
                .then(function() {
                    that.entries[entryId].chunklist_count++;
                    if (that.entries[entryId].chunklist_count === that.entries[entryId].last_chunklist_index - that.entries[entryId].initial_chunklist_index) {
                        finished_regression_test = true;
                    }
                })
                .catch(function (e) {
                    that.logger.error('[%s-%s] **** VALIDATION FAILED!!! **** error=[%s], url=[%s]', entryId, flavorId, e.message, url);
                })
        })
        .catch( function(err) {
            that.logger.info('[%s] validate skipped chunklist index %s. Error: %s', entryId, index, ErrorUtils.error2string(err));
        })
        .then( function() {
            if (finished_regression_test) {
                that.logger.debug('[%s] finished regression test on %s chunklists.', entryId, that.entries[entryId].chunklist_count);
                return testHelper.validators[entryId].saveResultsToFile('finished regression test. last chunklist index ' + index)
                    .then( function() {
                        return testHelper.validators[entryId].validateResults();
                    })
                    .then(function () {
                        process.exit(0);
                    })
                    .catch(function (err) {
                        testHelper.logger.error('[%s] failed to validate or save regression test results. Error: %s', entryId,ErrorUtils.error2string(err));
                        process.exit(-5);
                    });
            }
        });

}

TestHelper.prototype.resolveUrl = function(url, params) {

    var parsed = false;
    var re=/(.*)_definst_\/(.*)_(.*)\/(.*)/.exec(url);

    try {
        params.entryId = re[2];
        var relative_path = re[1]+ params.entryId;
        params.flavorId = re[3].split('/')[0];
        params.filename = re[4];
        var entry_path = testHelper.rootFolderPath;
        entry_path += relative_path;
        params.fullpath = entry_path;
        params.validate=false;

        // the order is very important!!!
        // call to isMinFlavor must precede the call to nextChunklist
        // otherwise the counter can increase the the value will no longer be the minimum resulting in unvalidated data

        // following code is meant for all chunklists download to be aligned
        if (params.filename.indexOf('chunklist.m3u8') > -1 ||
            params.filename.indexOf('playlist.m3u8') > -1 &&
            testHelper.entries[params.entryId].read[params.flavorId]) {
            params.validate = this.isMinFlavor(params.entryId, params.flavorId);
            var extended_filename = this.nextChunklist(params.entryId, params.flavorId);
            params.fullpath += '/' + params.flavorId + '/' + extended_filename;
        }
        // segments
        else if (params.filename.substr(-3).localeCompare('.ts') === 0) {
            params.fullpath += '/' + params.flavorId + '/' + params.filename;
        }
        // playlist
        else {
            params.fullpath += '/' + params.filename;
            params.playlist = true;
        }
        // Todo : make sure all the flavors chunklists are download is aligned.
        // this won't work if there is even single cunklist for single flavor that is missing in the
        // video entry repository
        // so, it is the responsibility of the Python live-testing application to make sure that
        // exact number of chunklist files with same names are downloaded.
        // otherwise there should be a mechanism to skip chunklists that are absent for one or more flavors

        parsed = true;
    } catch (err) {
        weblogger.error("Exception parsing url %s. Error: %s", url, ErrorUtils.error2string(err));
    }

    return parsed;
}

var httpMock=http.createServer(function(req, res) {

    var that = this;

    try {
         var params = {
             entryId: '',
             flavorId: '',
             fullpath: '',
             filename: '',
             validate: false,
             playlist: false
         };

        if (testHelper.resolveUrl(req.url, params)) {
            if (!params.playlist && testHelper.entries[params.entryId].playlist_initialized
                || (params.flavorId.indexOf('all') > -1)) {
                var p = Q.resolve();

                if (params.validate) {
                    p = testHelper.validateFlavor(params.entryId, params.flavorId);
                }

               p.finally(function () {
                    weblogger.debug('Reading [%s]', params.fullpath);
                    readFile(res, params.fullpath, params.entryId);
                    weblogger.debug('successfully read and validated [%s]', params.fullpath);
               });
            } else if (params.playlist) {
                res.writeHead(200);
                res.end(testHelper.getPlaylist(params.entryId, params.flavorId));
            }else {
                // Unprocessable Entity (WebDAV; RFC 4918)
                // The request was well-formed but was unable to be followed due to semantic errors.
                res.writeHead(422);
                res.end();
            }
        } else {
            // 400 Bad Request
            // The server cannot or will not process the request due to an apparent client error
            // (e.g., malformed request syntax, invalid request message framing, or deceptive request routing)
            res.writeHead(400);
            res.end();
        }
    }catch(err) {
        weblogger.error("Exception returning response to monitor server %s", ErrorUtils.error2string(err));
    }
}).listen(8888);

function RegressionAdapter() {
    var that = this;
    BaseAdapter.call(this);
    testHelper = new TestHelper();
    this.initPromise=testHelper.initEntries()
        .then(function() {
            return testHelper.initPlaylist();
        })
        .catch( function(err) {
          testHelper.logger.error('RegressionAdapter failed to initialize. Error=%s', ErrorUtils.error2string(err));
            throw err;
        });
}

util.inherits(RegressionAdapter,BaseAdapter);

RegressionAdapter.prototype.getLiveEntries=function() {

    return this.initPromise.then(function() {

        var result = [];
        // read the entry Ids and fill the result array
        // with entriesInfo configuration
        _.each(entriesInfo,function(template) {
            var entry = _.extend(template, {
                getStreamInfo: function () {
                    return new WowzaStreamInfo(this.entryId, this.flavorParamsIds, "");
                } });
            result.push(entry);
        })
        return (result);
    })
}


module.exports = RegressionAdapter;
