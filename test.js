const express = require("express");

const app = express();

app.use(express.json());

app.post("/test-webhook", (req, res) => {
  console.log("=================================");
  console.log("Webhook received");
  console.log("Time:", new Date().toISOString());
  console.log("Headers:", req.headers);
  console.log("Body:");
  console.log(JSON.stringify(req.body, null, 2));
  console.log("=================================\n");

  res.status(204).send();
});

app.listen(4000, () => {
  console.log("Test webhook listening on port 4000");
  console.log("URL: http://localhost:4000/test-webhook");
});