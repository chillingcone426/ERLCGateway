// Run: node connect.js
// Node 18+ needed (because fetch is built in)

const url = "https://api.libertytools.dev/webhook/9f8CKpVnYskUIZS6/events";
const everyMs = 2000;

console.log("Polling started...");

setInterval(async function () {
	try {
		// 1) Call the events API
		const response = await fetch(url);

		// 2) Read JSON from the response
		const data = await response.json();

		// 3) Show what came back
		let events = [];
		let count = 0;

		if (Array.isArray(data)) {
			events = data;
			count = data.length;
		} else if (data && Array.isArray(data.events)) {
			events = data.events;
			if (typeof data.count === "number") {
				count = data.count;
			} else {
				count = data.events.length;
			}
		} else {
			console.log("Response:", data);
			return;
		}

		console.log("------------------------------");
		console.log("Count:", count);
		if (events.length > 0) {
			for (let i = 0; i < events.length; i += 1) {
				const ev = events[i] || {};
				console.log(`Event ${i + 1}`);
				console.log("id:", ev._id || "");
				console.log("webhookId:", ev.webhookId || "");
				console.log("event:", ev.event || "");
				console.log("userId:", ev.userId || "");
				console.log("timestamp:", ev.timestamp || "");
				console.log("command:", ev.command || "");
				console.log("argument:", ev.argument || "");
				console.log("server:", ev.server || "");
				console.log("createdAt:", ev.createdAt || "");
				console.log("------------------------------");
			}
		} else {
			console.log("No events right now");
			console.log("------------------------------");
		}
	} catch (error) {
		console.log("Error:", error.message);
	}
}, everyMs);
