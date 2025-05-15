// Email Tracking Pixel System
// ========================
// Complete implementation of a tracking pixel system in Node.js
// for monitoring email opens, IP addresses, and other metrics

const express = require("express");
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
const geoip = require("geoip-lite");
const useragent = require("useragent");
const dotenv = require("dotenv");

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://nestCmsDbAdmin:dxZtvLO6O70UNd7c@cluster0.lyljemi.mongodb.net/email_tracking?retryWrites=true&w=majority";

// Connect to MongoDB
mongoose
  .connect(MONGODB_URI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Define schema for tracking data
const TrackingSchema = new mongoose.Schema({
  emailId: String,
  recipientEmail: String,
  campaignId: String,
  timestamp: { type: Date, default: Date.now },
  ipAddress: String,
  userAgent: String,
  device: String,
  browser: String,
  os: String,
  location: {
    country: String,
    region: String,
    city: String,
    ll: [Number], // latitude, longitude
  },
  openCount: { type: Number, default: 1 },
});

const Tracking = mongoose.model("Tracking", TrackingSchema);

// Middleware to parse request data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Generate a transparent 1x1 pixel GIF
const TRACKING_PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

// Route for tracking pixel
app.get("/pixel/:emailId", async (req, res) => {
  try {
    const { emailId } = req.params;
    const { campaign, email } = req.query;
    console.log(email);

    // Get IP address
    const ip =
      req.headers["x-forwarded-for"] ||
      req.connection.remoteAddress ||
      req.socket.remoteAddress;

    // Parse user agent
    const userAgentString = req.headers["user-agent"];
    const agent = useragent.parse(userAgentString);

    // Get geo location from IP
    const geo = geoip.lookup(ip);

    // Check if this email has been opened before
    const existingTracking = await Tracking.findOne({
      emailId,
      recipientEmail: email,
      ipAddress: ip,
    });

    if (existingTracking) {
      // Update existing tracking record
      existingTracking.openCount += 1;
      existingTracking.timestamp = new Date();
      await existingTracking.save();
    } else {
      // Create new tracking record
      const trackingData = {
        emailId,
        recipientEmail: email,
        campaignId: campaign,
        ipAddress: ip,
        userAgent: userAgentString,
        device: agent.device.toString(),
        browser: agent.toAgent(),
        os: agent.os.toString(),
      };

      // Add geo location if available
      if (geo) {
        trackingData.location = {
          country: geo.country,
          region: geo.region,
          city: geo.city,
          ll: geo.ll,
        };
      }

      await new Tracking(trackingData).save();
    }

    // Send the tracking pixel
    res.set("Content-Type", "image/gif");
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.send(TRACKING_PIXEL);
  } catch (error) {
    console.error("Tracking error:", error);
    // Still send the pixel even if tracking fails
    res.set("Content-Type", "image/gif");
    res.send(TRACKING_PIXEL);
  }
});

// API routes for retrieving tracking data
app.get("/api/tracking", async (req, res) => {
  try {
    const { emailId, email, campaign } = req.query;

    // Build query based on provided parameters
    const query = {};
    if (emailId) query.emailId = emailId;
    if (email) query.recipientEmail = email;
    if (campaign) query.campaignId = campaign;

    const trackingData = await Tracking.find(query);
    res.json(trackingData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get stats for a specific email
app.get("/api/stats/email/:emailId", async (req, res) => {
  try {
    const { emailId } = req.params;

    const totalOpens = await Tracking.aggregate([
      { $match: { emailId } },
      { $group: { _id: null, count: { $sum: "$openCount" } } },
    ]);

    const uniqueOpens = await Tracking.countDocuments({ emailId });

    const deviceStats = await Tracking.aggregate([
      { $match: { emailId } },
      { $group: { _id: "$device", count: { $sum: 1 } } },
    ]);

    const browserStats = await Tracking.aggregate([
      { $match: { emailId } },
      { $group: { _id: "$browser", count: { $sum: 1 } } },
    ]);

    const locationStats = await Tracking.aggregate([
      { $match: { emailId, "location.country": { $exists: true } } },
      { $group: { _id: "$location.country", count: { $sum: 1 } } },
    ]);

    res.json({
      emailId,
      totalOpens: totalOpens.length ? totalOpens[0].count : 0,
      uniqueOpens,
      deviceStats,
      browserStats,
      locationStats,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get campaign statistics
app.get("/api/stats/campaign/:campaignId", async (req, res) => {
  try {
    const { campaignId } = req.params;

    const totalEmails = await Tracking.distinct("emailId", { campaignId });
    const totalRecipients = await Tracking.distinct("recipientEmail", {
      campaignId,
    });

    const totalOpens = await Tracking.aggregate([
      { $match: { campaignId } },
      { $group: { _id: null, count: { $sum: "$openCount" } } },
    ]);

    const opensByEmail = await Tracking.aggregate([
      { $match: { campaignId } },
      {
        $group: {
          _id: "$recipientEmail",
          openCount: { $sum: "$openCount" },
          lastOpened: { $max: "$timestamp" },
        },
      },
    ]);

    res.json({
      campaignId,
      totalEmails: totalEmails.length,
      totalRecipients: totalRecipients.length,
      totalOpens: totalOpens.length ? totalOpens[0].count : 0,
      opensByEmail,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper API to create a new email with tracking code
app.post("/api/create-tracking", (req, res) => {
  try {
    const { emailId, recipientEmail, campaignId, baseUrl } = req.body;

    if (!emailId || !recipientEmail || !baseUrl) {
      return res.status(400).json({ error: "Required parameters missing" });
    }

    // Generate tracking URL
    const trackingUrl = `${baseUrl}/pixel/${emailId}?email=${encodeURIComponent(
      recipientEmail
    )}${campaignId ? `&campaign=${encodeURIComponent(campaignId)}` : ""}`;

    // Generate HTML code to insert in email
    const trackingHtml = `<img src="${trackingUrl}" width="1" height="1" alt="" style="display:none;">`;

    res.json({
      trackingUrl,
      trackingHtml,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Tracking pixel server running on port ${PORT}`);
});

// Example .env file
/*
PORT=3000
MONGODB_URI=mongodb://localhost:27017/tracking-pixel
*/

// Example usage in an email:
/*
To: recipient@example.com
Subject: Check out our latest products!

<html>
<body>
  <h1>Hello there!</h1>
  <p>Check out our latest products...</p>
  
  <!-- Tracking pixel -->
  <img src="https://your-domain.com/pixel/email123?email=recipient@example.com&campaign=summer2023" width="1" height="1" alt="" style="display:none;">
</body>
</html>
*/
