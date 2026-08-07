// Resume-PDF attachments. A compiled PDF is traced by two rows in the
// polymorphic `attachments` table pointing at the same on-disk file:
//   • entity_type='application', entity_id=<appId>  — surfaces in the app's
//     attachments list (existing behavior).
//   • entity_type='resume',      entity_id=<resumeId> — surfaces in a
//     "PDFs sent from this resume" list on Profile → Resumes.
// The bytes are written once via uploadAttachment; this module inserts both
// metadata rows in a single transaction.

import { exec, transaction } from '../db/client.mjs';
import { createAttachment } from './attachments.mjs';

// linkPdfToApplication takes the metadata returned from uploadAttachment plus
// (resumeId, applicationId) and creates both attachment rows atomically.
// Returns { applicationAttachmentId, resumeAttachmentId }.
export const linkPdfToApplication = async ({
  resumeId, applicationId,
  folder, storedFilename, originalFilename,
  mimeType, sizeBytes, sha256,
}) => {
  if (!resumeId) throw new Error('resumeId required');
  if (!applicationId) throw new Error('applicationId required');
  if (!folder) throw new Error('folder required');
  if (!storedFilename) throw new Error('storedFilename required');

  const base = {
    folder,
    filename: storedFilename,
    original_filename: originalFilename || storedFilename,
    mime_type: mimeType || 'application/pdf',
    size_bytes: sizeBytes || 0,
    sha256: sha256 || '',
  };
  return transaction(async () => {
    const applicationAttachmentId = await createAttachment({
      ...base, entity_type: 'application', entity_id: applicationId,
    });
    const resumeAttachmentId = await createAttachment({
      ...base, entity_type: 'resume', entity_id: resumeId,
    });
    return { applicationAttachmentId, resumeAttachmentId };
  });
};

// listPdfsForResume returns every attachment row where entity_type='resume'
// and entity_id=resumeId, joined with the paired application-side row (via
// folder+filename) so callers can render "sent to <application>" alongside.
// The join is best-effort: if the paired app row was deleted, application_*
// fields are NULL and the row still surfaces.
export const listPdfsForResume = (resumeId) => exec(
  `SELECT ra.id AS resume_attachment_id,
          ra.folder, ra.filename, ra.original_filename,
          ra.mime_type, ra.size_bytes, ra.sha256, ra.created_at,
          aa.entity_id AS application_id,
          app.role_title AS application_role_title,
          c.official_name AS application_company_name
   FROM attachments ra
   LEFT JOIN attachments aa
          ON aa.entity_type = 'application'
         AND aa.folder = ra.folder
         AND aa.filename = ra.filename
   LEFT JOIN applications app ON app.id = aa.entity_id
   LEFT JOIN companies c ON c.id = app.company_id
   WHERE ra.entity_type = 'resume' AND ra.entity_id = ?
   ORDER BY datetime(ra.created_at) DESC, ra.id DESC`,
  [resumeId],
);
