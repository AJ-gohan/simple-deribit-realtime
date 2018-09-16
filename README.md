# simple-deribit-realtime

### Example
```js
const socket = new SimpleDeribitRealtime({ 
  apiKey: "***", 
  apiSecret: "***" 
});
socket.on("open", async() => {
	console.log("Deribit:open");
	
  // new sell limit order 
	let res = await socket.callPrivate("sell", {
			instrument: "BTC-PERPETUAL",
			quantity: 1,
			type: "limit",
			post_only: true,
			time_in_force: "good_till_cancel",
			price: 6590
	});
  
});
socket.on("close", async() => {
	console.log("Deribit:close");
});
socket.on("error", async(error) => {
	console.log("Deribit:error");
});


socket.subscribe(["trade"], ["BTC-PERPETUAL"]);
socket.on("notification:trade_event", (trades) => {
	console.log(trades)
});
```
