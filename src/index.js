// src/index.js
import app from "./app.js";
import { connectDB } from "./config/db.js";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT;

async function startServer() {
  await connectDB(); // connect to MongoDB first

  app.listen(PORT, () => {
    console.log(" Server running on port", PORT);
  });
}

startServer();
