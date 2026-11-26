// server/routes/files.js : stockage privé (Supabase), remplace Firebase Storage
const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const requireUser = require('../middleware/requireUser');
const requireAdmin = require('../middleware/requireAdmin');

const router = express.Router();
const BUCKET = 'tapa-files';
const MAX_BYTES = 8 * 1024 * 1024;

// Client créé à la demande : des variables absentes ne doivent jamais empêcher le serveur de démarrer
let _client = null;
function bucket() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  if (!_client) {
    _client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
    });
  }
  return _client.storage.from(BUCKET);
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });
function recevoir(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const trop = err.code === 'LIMIT_FILE_SIZE';
      return res.status(trop ? 413 : 400).json({
        error: trop ? 'Fichier trop volumineux (8 Mo max)' : 'Fichier invalide',
      });
    }
    next();
  });
}

// Type réel du fichier d'après ses premiers octets (le type déclaré par le téléphone ne prouve rien)
function sniff(buf) {
  if (buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.slice(0, 4).toString('hex') === '89504e47') return { ext: 'png', mime: 'image/png' };
  if (buf.slice(0, 4).toString('ascii') === '%PDF') return { ext: 'pdf', mime: 'application/pdf' };
  return null;
}

const UID_OK = /^[A-Za-z0-9_-]{6,128}$/;
const PATH_OK = /^(cartes_grises|attestations)\/[A-Za-z0-9_-]{6,128}\/[A-Za-z0-9_.-]+$/;

// Dépôt d'une carte grise par le client connecté
router.post('/carte-grise', requireUser, recevoir, async (req, res) => {
  try {
    const b = bucket();
    if (!b) return res.status(503).json({ error: 'Stockage non configuré' });
    const uid = req.user.uid;
    if (!req.file) return res.status(400).json({ error: 'Fichier manquant' });
    const t = sniff(req.file.buffer);
    if (!t || t.mime === 'application/pdf') {
      return res.status(400).json({ error: 'Image JPEG ou PNG requise' });
    }
    const path = `cartes_grises/${uid}/${Date.now()}.${t.ext}`;
    const { error } = await b.upload(path, req.file.buffer, { contentType: t.mime });
    if (error) throw error;
    res.json({ path });
  } catch (e) {
    console.error('files/carte-grise:', e.message);
    res.status(500).json({ error: 'Envoi impossible' });
  }
});

// Dépôt d'une attestation PDF pour un client (admin seulement)
router.post('/attestation/:uid/:reference', requireAdmin, recevoir, async (req, res) => {
  try {
    const b = bucket();
    if (!b) return res.status(503).json({ error: 'Stockage non configuré' });
    const cible = req.params.uid;
    const ref = req.params.reference;
    if (!UID_OK.test(cible) || !/^[A-Za-z0-9_-]{3,64}$/.test(ref) || !req.file) {
      return res.status(400).json({ error: 'Requête invalide' });
    }
    const t = sniff(req.file.buffer);
    if (!t || t.mime !== 'application/pdf') return res.status(400).json({ error: 'PDF requis' });
    const path = `attestations/${cible}/${ref}.pdf`;
    const { error } = await b.upload(path, req.file.buffer, { contentType: t.mime, upsert: true });
    if (error) throw error;
    res.json({ path });
  } catch (e) {
    console.error('files/attestation:', e.message);
    res.status(500).json({ error: 'Envoi impossible' });
  }
});

async function lienTemporaire(path, res) {
  const b = bucket();
  if (!b) return res.status(503).json({ error: 'Stockage non configuré' });
  const { data, error } = await b.createSignedUrl(path, 300);
  if (error) return res.status(404).json({ error: 'Fichier introuvable' });
  res.json({ url: data.signedUrl, expireDans: 300 });
}

// Lecture par le propriétaire du fichier
router.get('/url', requireUser, (req, res) => {
  const path = String(req.query.path || '');
  if (!PATH_OK.test(path) || path.includes('..')) return res.status(400).json({ error: 'Chemin invalide' });
  if (path.split('/')[1] !== req.user.uid) return res.status(403).json({ error: 'Accès refusé' });
  return lienTemporaire(path, res);
});

// Lecture par un admin
router.get('/admin/url', requireAdmin, (req, res) => {
  const path = String(req.query.path || '');
  if (!PATH_OK.test(path) || path.includes('..')) return res.status(400).json({ error: 'Chemin invalide' });
  return lienTemporaire(path, res);
});

// Utilise par assurance.js : le fichier existe-t-il dans le bucket ?
router.fichierExiste = async function fichierExiste(path) {
  const b = bucket();
  if (!b) throw Object.assign(new Error('Stockage non configure'), { status: 503 });
  const i = path.lastIndexOf('/');
  const dossier = path.slice(0, i);
  const nom = path.slice(i + 1);
  const { data, error } = await b.list(dossier, { search: nom, limit: 20 });
  if (error) throw error;
  return (data || []).some((f) => f.name === nom);
};

module.exports = router;