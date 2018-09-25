
const net = require("net")
const crypto = require("crypto")
const EventEmitter = require("events")
const assert = require("assert")

const SimpleWebSocket = require("simple-web-socket-client-reconnect")
const Heartbeat = require("simple-realtime-helper-heartbeat")



class MakeDeribitRequest {
	constructor(options) {
		this.options = {
			apiKey: null,
			apiSecret: null,
			actionPrefix: "/api/v1/",

			...options
		};
	}
	
	getSignature(access_key, secret_key, action, args) {
		let nonce = 
			Math.round((Math.random() * 1e6)) + "" +
			Math.round((Math.random() * 1e6)) + "" +
			Math.round((Math.random() * 1e6)) + "" +
			Math.round((Math.random() * 1e6)) + "" ;

		let signatureString = 
			'_=' + nonce 
			+ '&_ackey=' + access_key
			+ '&_acsec=' + secret_key
			+ '&_action=' + action;

		Reflect.ownKeys(args).sort().forEach((key) => {
			signatureString += "&";
			signatureString += key;
			signatureString += "=";

			let value = args[key];
			if (Array.isArray(value)) {
				value = value.join('');
			}

			signatureString += value.toString();
		});
		

		let binaryHash = crypto.createHash("sha256").update(signatureString).digest();
		
		return (
			access_key + "." + 
			nonce.toString() + "." +  
			binaryHash.toString("base64")
		)
	}
	

	public(action, args = {}) {
		action = this.options.actionPrefix + "public/" + action;
		return {action, arguments: args};
	}
	private(action, args = {}) {
		assert(this.options.apiKey && this.options.apiSecret, "Api key and secret required")
		
		action = this.options.actionPrefix + "private/" + action;
		const sig = this.getSignature(this.options.apiKey, this.options.apiSecret, action, args);
		return {action, arguments: args, sig, id: 1};
	}
}




const HOST_DERIBIT = "www.deribit.com";
const HOST_DERIBIT_TESTNET = "testnet.deribit.com";



class DeribitError extends Error {
	constructor(...args) {
		super(args);
		
		this.name = "DeribitError";
	}
}
class DeribitErrorTimeout extends DeribitError {
	constructor(...args) {
		super(args);
		
		this.name = "DeribitError:Timeout";
	}
}
class DeribitErrorTransportClosed extends DeribitError {
	constructor(...args) {
		super(args);
		
		this.name = "DeribitError:TransportClosed";
	}
	
}
class DeribitErrorTransportError extends DeribitError {
	constructor(...args) {
		super(args);
		
		this.name = "DeribitError:TransportError";
	}
	
}

class DeribitRpc extends EventEmitter {
	constructor() {
		super();

		this.seq = 1;
		
		this.map = {};
		
		this.iid = setInterval(() => {
			const now = Date.now();
			const array = [];
			for(let i in this.map) {
				const ctx = this.map[i];
				if ( ctx.timeOpen + ctx.timeout < now ) {
					array.push(ctx);
				}
			}
			
			for(const ctx of array) {
				delete this.map[ctx.id];
			}
			for(const ctx of array) {
				ctx.reject(new DeribitErrorTimeout("Timeout"));
			}
		}, 1e3);
	}
	
	close() {
		clearInterval(this.iid);

		for(let i in this.map) {
			this.map[i].reject(new DeribitErrorTransportClosed("Transport closed"));
		}
	}
	
	async call(obj, timeout = 10e3) {
		return new Promise((resolve, reject) => {
			obj.id = this.seq++;
			const json = JSON.stringify(obj);
			//console.log(obj)

			this.map[obj.id] = {
				id: obj.id,
				resolve, reject,
				timeOpen: Date.now(),
				timeout
			};
			
			this.emit("message", json);
		});
	}

	recvMessage(message) {
		try {
			message = JSON.parse(message);
			//console.log(message);
			if ( typeof message.id === "number" ) {
				const ctx = this.map[message.id];
				if ( ctx ) {
					ctx.timeClose = Date.now();
					ctx.timeDelta = ctx.timeClose - ctx.timeOpen;
					message.ping = ctx.timeDelta;

					delete this.map[message.id];
					
					if ( message.success ) {
						ctx.resolve(message);
					} else {
						const error = new DeribitError( (message.message || "") + (typeof message.error === "number" ? " (Code: "+message.error+")" : ""));
						error.error = message.error;
						ctx.reject(error);
					}
				}
				
				return;
			}
			
			if ( Array.isArray(message.notifications) ) {
				message.notifications.forEach((not) => {
					if ( not.success ) {
						this.emit("notification", not)
					}
				});
			}

			if ( typeof message.message === "string" ) {
				this.emit("notification:message", message.message);
			}
		} catch(e) {}
	}
}



class SimpleDeribitRealtime extends EventEmitter {
	constructor(options) {
		super();
		
		this.options = {
			apiKey: null,
			apiSecret: null,
			actionPrefix: "/api/v1/",
			testnet: false,
			
			heartbeat: 0,
			msg_timeout: 5e3,
			ping_timeout: 5e3,
			ping_timeinterval: 1e3,

			...options
		};
		
		this.apiVersion = "v1";
		
		this._subscribe = {event: [], instrument: []};
		this.mdr = new MakeDeribitRequest(this.options);
		this.rpc = null;
	
		/////////////////////// Heartbeat
		if ( this.options.heartbeat ) {
			const heartbeat = new Heartbeat(this, this.options);
			heartbeat.on("send:ping", () => {
				this.callPublic("ping").then(() => {
					heartbeat.emit("recv:pong", {});
				}).catch(_=>0);
			});
			heartbeat.on("ping", (info) => {
				this.emit("ping", {time: info.time, ping: info.ping});
			});
			heartbeat.on("reconnect", () => {
				this.webSocket.reopen();
			});
		}

	
		this.webSocket = new SimpleWebSocket( "wss://" + (!this.options.testnet ? HOST_DERIBIT : HOST_DERIBIT_TESTNET) + "/ws/api/" + this.apiVersion + "/" );
		this.webSocket.on("message", this._onMessage.bind(this));
		this.webSocket.on("open", () => {
			this.rpc = new DeribitRpc();
			
			this.rpc.on("message", (message) => {
				this.webSocket.send(message);
			});
			this.rpc.on("notification", (message) => {
				this.emit("rawnotification", message);
				this.emit("notification:"+message.message, message.result);
			});
			this.rpc.on("notification:message", (message) => {
				if ( message === "test_request" ) {
					this.callPublic("test");
				}
			});
			this.emit("open");
			
			//console.log((this._subscribe));
			this.callPrivate("subscribe", this._subscribe).catch(e => 0)
			
			this.callPublic("setheartbeat", {interval: 10});
		});
		this.webSocket.on("close", () => {
			this.rpc && this.rpc.close();
			this.rpc = null;
			
			this.emit("close");
		});
		this.webSocket.on("error", (error) => {
			this.emit("error", new DeribitErrorTransportError(error.message));
		});
	}
	
	close() {
		this.webSocket.close();
	}
	
	_onMessage(message) {
		//console.log(message)
		this.rpc.recvMessage(message);
	}

	subscribe(event, instrument) {
		this._subscribe = {event, instrument};
		
		if ( this.rpc ) {
			this.callPrivate("subscribe", this._subscribe).catch(e => 0)
		}
	}
	unsubscribe(events, instruments) {
		if ( this.rpc ) {
			this.callPrivate("unsubscribe", this._subscribe).catch(e => 0)
		}
		this._subscribe = {event: [], instrument: []};
	}

	async callPublic(action, options, timeout) {
		assert(this.rpc, "Not open")
		
		const obj = this.mdr.public(action, options);
		return this.rpc.call(obj, timeout);
	}
	async callPrivate(action, options, timeout) {
		assert(this.rpc, "Not open")
		
		const obj = this.mdr.private(action, options);
		return this.rpc.call(obj, timeout);
	}
	
}



module.exports = SimpleDeribitRealtime;

