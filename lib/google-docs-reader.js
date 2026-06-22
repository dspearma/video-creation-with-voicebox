const { google } = require('googleapis');
const { getAuthenticatedClient } = require('./google-auth');

/**
 * List recent Google Docs from the user's Drive.
 * Returns an array of {id, name, modifiedTime}.
 */
async function listGoogleDocs() {
  const auth = getAuthenticatedClient();
  if (!auth) throw new Error('Not authenticated with Google');

  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.list({
    q: "mimeType='application/vnd.google-apps.document'",
    fields: 'files(id, name, modifiedTime)',
    orderBy: 'modifiedTime desc',
    pageSize: 50,
  });

  return (res.data.files || []).map((f) => ({
    id: f.id,
    name: f.name,
    modifiedTime: f.modifiedTime,
  }));
}

/**
 * Read the full text content of a Google Doc by ID.
 * Extracts all text from the document body, preserving paragraph structure.
 */
async function readGoogleDoc(docId) {
  const auth = getAuthenticatedClient();
  if (!auth) throw new Error('Not authenticated with Google');

  const docs = google.docs({ version: 'v1', auth });
  const res = await docs.documents.get({ documentId: docId });
  const doc = res.data;

  // Extract text from document body content
  let text = '';
  if (doc.body && doc.body.content) {
    for (const element of doc.body.content) {
      if (element.paragraph && element.paragraph.elements) {
        for (const el of element.paragraph.elements) {
          if (el.textRun && el.textRun.content) {
            text += el.textRun.content;
          }
        }
      }
    }
  }

  return {
    title: doc.title || 'Untitled',
    text: text.trim(),
  };
}

module.exports = {
  listGoogleDocs,
  readGoogleDoc,
};
