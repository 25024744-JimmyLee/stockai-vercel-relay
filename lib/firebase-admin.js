import admin from 'firebase-admin';

import { RelayError } from './relay-http.js';
import { requireEnvironment } from './relay-security.js';

export function getFirestore() {
  if (!admin.apps.length) {
    const projectId = requireEnvironment('FIREBASE_PROJECT_ID', 'Firebase project');
    const clientEmail = requireEnvironment('FIREBASE_CLIENT_EMAIL', 'Firebase service account');
    const privateKey = requireEnvironment('FIREBASE_PRIVATE_KEY', 'Firebase service account')
      .replace(/\\n/g, '\n');
    try {
      admin.initializeApp({
        credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
      });
    } catch {
      throw new RelayError(
        503,
        'FIREBASE_NOT_CONFIGURED',
        'Firebase Admin is not configured correctly.',
      );
    }
  }
  return admin.firestore();
}

export function serverTimestamp() {
  return admin.firestore.FieldValue.serverTimestamp();
}
