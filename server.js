require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const compression = require('compression');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./lib/db');

db.ensure();

const app = express();
const PORT = process.env.PORT || 8000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false // relaxed so AdSense / analytics scripts set via admin panel can load
}));
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Track page visits for the admin dashboard. Runs only for real page
// navigations — API calls, admin routes, and static assets are skipped.
const TRACK_EXCLUDE_PREFIXES = ['/admin', '/api', '/css', '/js', '/img'];
const TRACK_EXCLUDE_EXACT = ['/favicon.svg', '/robots.txt', '/sitemap.xml'];
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (TRACK_EXCLUDE_EXACT.includes(req.path)) return next();
  if (TRACK_EXCLUDE_PREFIXES.some(p => req.path.startsWith(p))) return next();
  if (!(req.headers.accept || '').includes('text/html')) return next();

  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  db.addPageView({
    path: req.path,
    ip,
    referrer: req.headers['referer'] || '',
    userAgent: req.headers['user-agent'] || '',
    timestamp: new Date().toISOString()
  });
  next();
});

app.use(session({
  secret: process.env.SESSION_SECRET || 'swiftspeed-please-change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8, sameSite: 'lax' }
}));

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect('/admin/login');
}

/* ---------------------------------------------------------------- */
/*  PUBLIC SITE                                                      */
/* ---------------------------------------------------------------- */

app.get('/', (req, res) => {
  const settings = db.getSettings();
  if (settings.maintenanceMode) {
    return res.status(503).render('maintenance', { settings });
  }
  res.render('index', { settings });
});

app.get('/about', (req, res) => {
  res.render('about', { settings: db.getSettings() });
});

app.get('/contact', (req, res) => {
  res.render('contact', { settings: db.getSettings(), sent: req.query.sent === '1' });
});

app.post('/contact', (req, res) => {
  const { name, email, message } = req.body;
  if (name && email && message) {
    db.addMessage({
      id: crypto.randomUUID(),
      name,
      email,
      message,
      timestamp: new Date().toISOString()
    });
  }
  res.redirect('/contact?sent=1');
});

app.get('/privacy-policy', (req, res) => {
  res.render('privacy', { settings: db.getSettings() });
});

app.get('/terms-of-service', (req, res) => {
  res.render('terms', { settings: db.getSettings() });
});

app.get('/disclaimer', (req, res) => {
  res.render('disclaimer', { settings: db.getSettings() });
});

app.get('/cookie-policy', (req, res) => {
  res.render('cookies', { settings: db.getSettings() });
});

/* ---------------------------------------------------------------- */
/*  SPEED TEST API                                                   */
/* ---------------------------------------------------------------- */

// Tiny endpoint used to measure latency (ping) and jitter.
// Client hits this repeatedly and times the round trip.
app.get('/api/ping', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(204).end();
});

// Streams random bytes for the download test.
// ?bytes=25000000  (defaults to 20MB, capped by settings.maxDownloadTestBytes)
app.get('/api/download', (req, res) => {
  const settings = db.getSettings();
  let bytes = parseInt(req.query.bytes, 10) || 20 * 1000 * 1000;
  bytes = Math.min(bytes, settings.maxDownloadTestBytes || 100 * 1000 * 1000);

  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Length': bytes,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache'
  });

  const chunkSize = 256 * 1024;
  const chunk = crypto.randomBytes(chunkSize);
  let sent = 0;

  function pump() {
    let ok = true;
    while (sent < bytes && ok) {
      const remaining = bytes - sent;
      const toSend = remaining < chunkSize ? chunk.slice(0, remaining) : chunk;
      ok = res.write(toSend);
      sent += toSend.length;
    }
    if (sent < bytes) {
      res.once('drain', pump);
    } else {
      res.end();
    }
  }
  pump();
});

// Accepts raw uploaded bytes for the upload test. We only need to
// consume the stream — the client measures its own upload duration.
app.post('/api/upload', (req, res) => {
  let received = 0;
  req.on('data', (chunk) => { received += chunk.length; });
  req.on('end', () => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, bytesReceived: received });
  });
  req.on('error', () => res.status(400).json({ ok: false }));
});

// Basic IP / connection info shown to the user.
app.get('/api/ip-info', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const r = await fetch(`https://ipapi.co/${ip}/json/`, { signal: controller.signal });
    clearTimeout(t);
    if (r.ok) {
      const data = await r.json();
      return res.json({
        ip: data.ip || ip,
        isp: data.org || 'Unknown ISP',
        city: data.city || '',
        region: data.region || '',
        country: data.country_name || ''
      });
    }
  } catch (e) {
    // fall through to basic response below
  }
  res.json({ ip: ip || 'Unknown', isp: 'Unknown ISP', city: '', region: '', country: '' });
});

// Client submits a finished test result, we log it for the admin dashboard.
app.post('/api/results', (req, res) => {
  const { download, upload, ping, jitter, ip, isp, deviceType } = req.body || {};
  const entry = {
    id: crypto.randomUUID(),
    download: Number(download) || 0,
    upload: Number(upload) || 0,
    ping: Number(ping) || 0,
    jitter: Number(jitter) || 0,
    ip: ip || '',
    isp: isp || '',
    deviceType: deviceType || 'unknown',
    userAgent: req.headers['user-agent'] || '',
    timestamp: new Date().toISOString()
  };
  db.addResult(entry);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------- */
/*  ADMIN PANEL                                                       */
/* ---------------------------------------------------------------- */

app.get('/admin', (req, res) => res.redirect(req.session.isAdmin ? '/admin/dashboard' : '/admin/login'));

app.get('/admin/login', (req, res) => {
  res.render('admin/login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  const admin = db.getAdmin();
  if (username === admin.username && bcrypt.compareSync(password || '', admin.passwordHash)) {
    req.session.isAdmin = true;
    req.session.adminUser = username;
    return res.redirect('/admin/dashboard');
  }
  res.render('admin/login', { error: 'Invalid username or password.' });
});

app.post('/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

app.get('/admin/dashboard', requireAdmin, (req, res) => {
  const results = db.getResults();
  const total = results.length;
  const avg = (key) => total ? (results.reduce((s, r) => s + (r[key] || 0), 0) / total) : 0;
  const stats = {
    total,
    avgDownload: avg('download').toFixed(2),
    avgUpload: avg('upload').toFixed(2),
    avgPing: avg('ping').toFixed(1),
    mobileCount: results.filter(r => r.deviceType === 'mobile').length,
    desktopCount: results.filter(r => r.deviceType === 'desktop').length
  };

  const viewStats = db.getViewStats();
  const recentViews = db.getRecentViews(500);
  const today = new Date().toISOString().slice(0, 10);
  const todayViews = viewStats.dailyViews[today] || 0;
  const uniqueToday = new Set(
    recentViews.filter(v => v.timestamp.slice(0, 10) === today).map(v => v.ip)
  ).size;

  // Last 7 days, oldest first
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    last7.push({ date: key, count: viewStats.dailyViews[key] || 0 });
  }

  const pageCounts = {};
  recentViews.forEach(v => { pageCounts[v.path] = (pageCounts[v.path] || 0) + 1; });
  const topPages = Object.entries(pageCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const visitStats = {
    totalViews: viewStats.totalViews || 0,
    todayViews,
    uniqueToday,
    last7,
    topPages
  };

  res.render('admin/dashboard', {
    stats, recent: results.slice(0, 15), adminUser: req.session.adminUser,
    visitStats, recentVisits: recentViews.slice(0, 15),
    unreadMessages: db.getMessages().length
  });
});

app.get('/admin/visits', requireAdmin, (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const perPage = 40;
  const all = db.getRecentViews(10000);
  const start = (page - 1) * perPage;
  res.render('admin/visits', {
    views: all.slice(start, start + perPage),
    page,
    totalPages: Math.max(1, Math.ceil(all.length / perPage)),
    total: db.getViewStats().totalViews || 0
  });
});

app.post('/admin/visits/clear', requireAdmin, (req, res) => {
  db.clearViews();
  res.redirect('/admin/visits');
});

app.get('/admin/messages', requireAdmin, (req, res) => {
  res.render('admin/messages', { messages: db.getMessages() });
});

app.post('/admin/messages/clear', requireAdmin, (req, res) => {
  db.clearMessages();
  res.redirect('/admin/messages');
});

app.get('/admin/results', requireAdmin, (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const perPage = 25;
  const all = db.getResults();
  const start = (page - 1) * perPage;
  const pageItems = all.slice(start, start + perPage);
  res.render('admin/results', {
    results: pageItems,
    page,
    totalPages: Math.max(1, Math.ceil(all.length / perPage)),
    total: all.length
  });
});

app.post('/admin/results/clear', requireAdmin, (req, res) => {
  db.clearResults();
  res.redirect('/admin/results');
});

app.get('/admin/settings', requireAdmin, (req, res) => {
  res.render('admin/settings', { settings: db.getSettings(), saved: req.query.saved === '1' });
});

app.post('/admin/settings', requireAdmin, (req, res) => {
  const current = db.getSettings();
  const updated = {
    ...current,
    siteName: req.body.siteName || current.siteName,
    tagline: req.body.tagline || current.tagline,
    metaDescription: req.body.metaDescription || current.metaDescription,
    metaKeywords: req.body.metaKeywords || current.metaKeywords,
    adsEnabled: req.body.adsEnabled === 'on',
    adsenseClientId: req.body.adsenseClientId || '',
    adSlotHeader: req.body.adSlotHeader || '',
    adSlotSidebar: req.body.adSlotSidebar || '',
    adSlotFooter: req.body.adSlotFooter || '',
    adSlotBetweenResults: req.body.adSlotBetweenResults || '',
    maintenanceMode: req.body.maintenanceMode === 'on',
    googleAnalyticsId: req.body.googleAnalyticsId || '',
    maxDownloadTestBytes: parseInt(req.body.maxDownloadTestBytes, 10) || current.maxDownloadTestBytes
  };
  db.saveSettings(updated);
  res.redirect('/admin/settings?saved=1');
});

app.post('/admin/change-password', requireAdmin, (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const admin = db.getAdmin();
  if (!bcrypt.compareSync(currentPassword || '', admin.passwordHash)) {
    return res.render('admin/settings', { settings: db.getSettings(), saved: false, pwError: 'Current password is incorrect.' });
  }
  if (!newPassword || newPassword.length < 8) {
    return res.render('admin/settings', { settings: db.getSettings(), saved: false, pwError: 'New password must be at least 8 characters.' });
  }
  if (newPassword !== confirmPassword) {
    return res.render('admin/settings', { settings: db.getSettings(), saved: false, pwError: 'Passwords do not match.' });
  }
  admin.passwordHash = bcrypt.hashSync(newPassword, 10);
  db.saveAdmin(admin);
  res.render('admin/settings', { settings: db.getSettings(), saved: false, pwSuccess: 'Password updated successfully.' });
});

/* ---------------------------------------------------------------- */

app.get('/robots.txt', (req, res) => res.sendFile(path.join(__dirname, 'public', 'robots.txt')));
app.get('/sitemap.xml', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sitemap.xml')));

app.use((req, res) => res.status(404).render('404'));

app.listen(PORT, () => {
  console.log(`SwiftSpeed Test running on port ${PORT}`);
});
