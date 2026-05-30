/**
 * Cloudflare Worker — Regent Exam PDF Mailer
 * Receives schedule data from the browser, sends via Resend.
 * Deploy at: https://dash.cloudflare.com → Workers & Pages → Create Worker
 * Set secret: RESEND_API_KEY  (Workers → Settings → Variables → Add Secret)
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    const { to_email, to_name, pdf_base64, filename, schedule_html, from_address } = body;

    if (!to_email || !pdf_base64) {
      return new Response(JSON.stringify({ error: 'Missing to_email or pdf_base64' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    const FROM = from_address || env.FROM_ADDRESS || 'Regent Exams <exams@regent.edu.pl>';
    const SUBJECT = `Invigilation Schedule — ${to_name || to_email}`;

    const emailPayload = {
      from:    FROM,
      to:      [to_email],
      subject: SUBJECT,
      html:    schedule_html || `<p>Dear ${to_name || 'Invigilator'},</p><p>Please find your invigilation schedule attached.</p>`,
      attachments: [{
        filename: filename || 'Invigilation_Schedule.pdf',
        content:  pdf_base64,          // base64-encoded PDF
      }],
    };

    const resendRes = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(emailPayload),
    });

    const resendData = await resendRes.json();

    if (!resendRes.ok) {
      return new Response(JSON.stringify({ error: resendData }), {
        status: resendRes.status,
        headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ ok: true, id: resendData.id }), {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  },
};
