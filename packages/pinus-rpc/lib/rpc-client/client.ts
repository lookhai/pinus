import { getLogger, Logger } from 'pinus-logger'
let logger = getLogger('pinus-rpc', 'rpc-client');
import { failureProcess } from './failureProcess';
import { constants } from '../util/constants';
import * as Station from './mailstation';
import { Tracer } from '../util/tracer';
import * as Loader from 'pinus-loader';
import * as utils from '../util/utils';
import * as Proxy from '../util/proxy';
import * as router from './router';
import * as async from 'async';
import {RpcServerInfo, MailStation, MailStationErrorHandler, RpcFilter} from './mailstation'
import { ErrorCallback } from 'async';
import { MailBoxFactory } from './mailbox';
import { ConsistentHash } from '../util/consistentHash';
import { RemoteServerCode } from '../../index';

/**
 * Client states
 */
let STATE_INITED = 1; // client has inited
let STATE_STARTED = 2; // client has started
let STATE_CLOSED = 3; // client has closed

export type Router = typeof router.df | {route : typeof router.df};
export interface RouteContext
{
    getServersByType(serverType:string):RpcServerInfo[];
}

export type Proxies = {[namespace:string]:{[serverType:string]:{[attr:string]:Function}}}

export interface RpcClientOpts 
{
    context?: any,
    routeContext?: RouteContext,
    router?: Router,
    routerType?: string,
    rpcDebugLog?: boolean,
    clientId?: string,
    servers?: {serverType: Array<RpcServerInfo>}, 
    mailboxFactory?: MailBoxFactory,
    rpcLogger?: Logger,
    station ?: MailStation,
    hashFieldIndex ?: number;
}

export interface RpcMsg 
{ 
    namespace: string; 
    serverType: string;
    service: string; 
    method: string; 
    args: any[]
}


/**
 * RPC Client Class
 */
export class RpcClient
{
    _context: any;
    _routeContext: RouteContext;
    router: Router;
    routerType: string;
    rpcDebugLog: boolean;
    opts: RpcClientOpts;
    proxies: Proxies;
    _station: MailStation;
    state: number;

    wrrParam ?: {[serverType:string] : {index:number,weight : number}};
    chParam ?:  {[serverType:string] : {consistentHash:ConsistentHash}};

    constructor(opts?: RpcClientOpts)
    {
        opts = opts || {};
        this._context = opts.context;
        this._routeContext = opts.routeContext;
        this.router = opts.router || router.df;
        this.routerType = opts.routerType;
        this.rpcDebugLog = opts.rpcDebugLog;
        if (this._context)
        {
            opts.clientId = this._context.serverId;
        }
        this.opts = opts;
        this.proxies = {};
        this._station = createStation(opts);
        this.state = STATE_INITED;
    };

    /**
     * Start the rpc client which would try to connect the remote servers and
     * report the result by cb.
     *
     * @param cb {Function} cb(err)
     */
    start(cb: (err?:Error)=>void)
    {
        if (this.state > STATE_INITED)
        {
            cb(new Error('rpc client has started.'));
            return;
        }

        let self = this;
        this._station.start(function (err: Error)
        {
            if (err)
            {
                logger.error('[pinus-rpc] client start fail for ' + err.stack);
                return cb(err);
            }
            self._station.on('error', failureProcess.bind(self._station));
            self.state = STATE_STARTED;
            cb();
        });
    };

    /**
     * Stop the rpc client.
     *
     * @param  {Boolean} force
     * @return {Void}
     */
    stop(force: boolean)
    {
        if (this.state !== STATE_STARTED)
        {
            logger.warn('[pinus-rpc] client is not running now.');
            return;
        }
        this.state = STATE_CLOSED;
        this._station.stop(force);
    };

    /**
     * Add a new proxy to the rpc client which would overrid the proxy under the
     * same key.
     *
     * @param {Object} record proxy description record, format:
     *                        {namespace, serverType, path}
     */
    addProxy(record: RemoteServerCode)
    {
        if (!record)
        {
            return;
        }
        let proxy = generateProxy(this, record, this._context);
        if (!proxy)
        {
            return;
        }
        insertProxy(this.proxies, record.namespace, record.serverType, proxy);
    };

    /**
     * Batch version for addProxy.
     *
     * @param {Array} records list of proxy description record
     */
    addProxies(records: RemoteServerCode[])
    {
        if (!records || !records.length)
        {
            return;
        }
        for (let i = 0, l = records.length; i < l; i++)
        {
            this.addProxy(records[i]);
        }
    };

    /**
     * Add new remote server to the rpc client.
     *
     * @param {Object} server new server information
     */
    addServer(server: RpcServerInfo)
    {
        this._station.addServer(server);
    };

    /**
     * Batch version for add new remote server.
     *
     * @param {Array} servers server info list
     */
    addServers(servers: RpcServerInfo[])
    {
        this._station.addServers(servers);
    };

    /**
     * Remove remote server from the rpc client.
     *
     * @param  {String|Number} id server id
     */
    removeServer(id: string|number)
    {
        this._station.removeServer(id);
    };

    /**
     * Batch version for remove remote server.
     *
     * @param  {Array} ids remote server id list
     */
    removeServers(ids: Array<string|number>)
    {
        this._station.removeServers(ids);
    };

    /**
     * Replace remote servers.
     *
     * @param {Array} servers server info list
     */
    replaceServers(servers: RpcServerInfo[])
    {
        this._station.replaceServers(servers);
    };

    /**
     * Do the rpc invoke directly.
     *
     * @param serverId {String} remote server id
     * @param msg {Object} rpc message. Message format:
     *    {serverType: serverType, service: serviceName, method: methodName, args: arguments}
     * @param cb {Function} cb(err, ...)
     */
    rpcInvoke(serverId: string, msg: RpcMsg, cb: (err : Error , ...args : any[])=>void)
    {
        let rpcDebugLog = this.rpcDebugLog;
        let tracer :Tracer;

        if (rpcDebugLog)
        {
            tracer = new Tracer(this.opts.rpcLogger, this.opts.rpcDebugLog, this.opts.clientId, serverId, msg);
            tracer.info('client', __filename, 'rpcInvoke', 'the entrance of rpc invoke');
        }

        if (this.state !== STATE_STARTED)
        {
            tracer && tracer.error('client', __filename, 'rpcInvoke', 'fail to do rpc invoke for client is not running');
            logger.error('[pinus-rpc] fail to do rpc invoke for client is not running');
            cb(new Error('[pinus-rpc] fail to do rpc invoke for client is not running'));
            return;
        }
        this._station.dispatch(tracer, serverId, msg, this.opts, cb);
    };

    /**
     * Add rpc before filter.
     * 
     * @param filter {Function} rpc before filter function.
     *
     * @api public
     */
    before(filter: RpcFilter | RpcFilter[])
    {
        this._station.before(filter);
    };

    /**
     * Add rpc after filter.
     * 
     * @param filter {Function} rpc after filter function.
     *
     * @api public
     */
    after(filter: RpcFilter | RpcFilter[])
    {
        this._station.after(filter);
    };

    /**
     * Add rpc filter.
     * 
     * @param filter {Function} rpc filter function.
     *
     * @api public
     */
    filter(filter: RpcFilter)
    {
        this._station.filter(filter);
    };

    /**
     * Set rpc filter error handler.
     * 
     * @param handler {Function} rpc filter error handler function.
     *
     * @api public
     */
    setErrorHandler(handler: MailStationErrorHandler)
    {
        this._station.handleError = handler;
    };
}

/**
 * Create mail station.
 *
 * @param opts {Object} construct parameters.
 *
 * @api private
 */
let createStation = function (opts: RpcClientOpts)
{
    return Station.createMailStation(opts);
};

/**
 * Generate proxies for remote servers.
 *
 * @param client {Object} current client instance.
 * @param record {Object} proxy reocrd info. {namespace, serverType, path}
 * @param context {Object} mailbox init context parameter
 *
 * @api private
 */
let generateProxy = function (client: RpcClient, record: RemoteServerCode, context: object)
{
    if (!record)
    {
        return;
    }
    let res: {[key:string]: any}, name;
    let modules: {[key:string]: any} = Loader.load(record.path, context, false);
    if (modules)
    {
        res = {};
        for (name in modules)
        {
            res[name] = Proxy.create({
                service: name,
                origin: modules[name],
                attach: record,
                proxyCB: proxyCB.bind(null, client)
            });
        }
    }
    return res;
};

/**
 * Generate prxoy for function type field
 *
 * @param client {Object} current client instance.
 * @param serviceName {String} delegated service name.
 * @param methodName {String} delegated method name.
 * @param args {Object} rpc invoke arguments.
 * @param attach {Object} attach parameter pass to proxyCB.
 * @param isToSpecifiedServer {boolean} true means rpc route to specified remote server.
 *
 * @api private
 */
let proxyCB = function (client: RpcClient, serviceName: string, methodName: string, args: Array<any>, attach: {[key: string]: any}, isToSpecifiedServer: boolean)
{
    if (client.state !== STATE_STARTED)
    {
        Promise.reject(new Error('[pinus-rpc] fail to invoke rpc proxy for client is not running'));
        return;
    }
    if (args.length < 2)
    {

        logger.error('[pinus-rpc] invalid rpc invoke, arguments length less than 2, namespace: %j, serverType, %j, serviceName: %j, methodName: %j',
            attach.namespace, attach.serverType, serviceName, methodName);
        Promise.reject(new Error('[pinus-rpc] invalid rpc invoke, arguments length less than 2'));
        return;
    }
    let routeParam = args.shift();
    let serverType = attach.serverType;
    let msg = {
        namespace: attach.namespace,
        serverType: serverType,
        service: serviceName,
        method: methodName,
        args: args
    };

    return new Promise(function (resolve, reject)
    {
        if (isToSpecifiedServer)
        {
            rpcToSpecifiedServer(client, msg, serverType, routeParam, resolve);
        }
        else
        {
            getRouteTarget(client, serverType, msg, routeParam, function (err: Error, serverId: string)
            {
                if (err)
                {
                    return resolve(err);
                }

                client.rpcInvoke(serverId, msg, function (err: Error, resp: string)
                {
                    if (err != null)
                    {
                        reject(err);
                    }
                    else
                    {
                        resolve(resp);
                    }
                });
            });
        }
    });
};

/**
 * Calculate remote target server id for rpc client.
 *
 * @param client {Object} current client instance.
 * @param serverType {String} remote server type.
 * @param routeParam {Object} mailbox init context parameter.
 * @param cb {Function} return rpc remote target server id.
 *
 * @api private
 */
let getRouteTarget = function (client: RpcClient, serverType: string, msg: RpcMsg, routeParam: object, cb: (err: Error, serverId:string)=>void)
{
    if (!!client.routerType)
    {
        let method;
        switch (client.routerType)
        {
            case constants.SCHEDULE.ROUNDROBIN:
                method = router.rr;
                break;
            case constants.SCHEDULE.WEIGHT_ROUNDROBIN:
                method = router.wrr;
                break;
            case constants.SCHEDULE.LEAST_ACTIVE:
                method = router.la;
                break;
            case constants.SCHEDULE.CONSISTENT_HASH:
                method = router.ch;
                break;
            default:
                method = router.rd;
                break;
        }
        method.call(null, client, serverType, msg, function (err: Error, serverId: string)
        {
            cb(err, serverId);
        });
    } else
    {
        let route, target;
        if (typeof client.router === 'function')
        {
            route = client.router;
            target = null;
        } else if (typeof client.router.route === 'function')
        {
            route = client.router.route;
            target = client.router;
        } else
        {
            logger.error('[pinus-rpc] invalid route function.');
            return;
        }
        route.call(target, routeParam, msg, client._routeContext, function (err: Error, serverId: string)
        {
            cb(err, serverId);
        });
    }
};

/**
 * Rpc to specified server id or servers.
 *
 * @param client     {Object} current client instance.
 * @param msg        {Object} rpc message.
 * @param serverType {String} remote server type.
 * @param serverId   {Object} mailbox init context parameter.
 *
 * @api private
 */
let rpcToSpecifiedServer = function (client: RpcClient, msg: RpcMsg, serverType: string, serverId: string, cb: ErrorCallback<{}>)
{
    if (typeof serverId !== 'string')
    {
        logger.error('[pinus-rpc] serverId is not a string : %s', serverId);
        return;
    }
    if (serverId === '*')
    {
        let servers = client._routeContext.getServersByType(serverType);
        if (!servers)
        {
            logger.error('[pinus-rpc] serverType %s servers not exist', serverType);
            return;
        }

        async.each(servers, function (server, next)
        {
            let serverId = server['id'];
            client.rpcInvoke(serverId, msg, function (err: Error)
            {
                next(err);
            });
        }, cb);
    } else
    {
        client.rpcInvoke(serverId, msg, cb);
    }
};

/**
 * Add proxy into array.
 * 
 * @param proxies {Object} rpc proxies
 * @param namespace {String} rpc namespace sys/user
 * @param serverType {String} rpc remote server type
 * @param proxy {Object} rpc proxy
 *
 * @api private
 */
let insertProxy = function (proxies: Proxies, namespace: string, serverType: string, proxy: {[key: string]:any})
{
    proxies[namespace] = proxies[namespace] || {};
    if (proxies[namespace][serverType])
    {
        for (let attr in proxy)
        {
            proxies[namespace][serverType][attr] = proxy[attr];
        }
    } else
    {
        proxies[namespace][serverType] = proxy;
    }
};

/**
 * RPC client factory method.
 *
 * @param  {Object}      opts client init parameter.
 *                       opts.context: mail box init parameter,
 *                       opts.router: (optional) rpc message route function, route(routeParam, msg, cb),
 *                       opts.mailBoxFactory: (optional) mail box factory instance.
 * @return {Object}      client instance.
 */
export function createClient(opts: RpcClientOpts)
{
    return new RpcClient(opts);
};

// module.exports.WSMailbox from ('./mailboxes/ws-mailbox'); // socket.io 
// module.exports.WS2Mailbox from ('./mailboxes/ws2-mailbox'); // ws
export { create as MQTTMailbox } from './mailboxes/mqtt-mailbox'; // mqtt
