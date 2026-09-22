const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

function createSupportAi({ supabase, env = process.env, fetchImpl = fetch } = {}) {
  async function callGemini(prompt) {
    const apiKey = String(env.GEMINI_API_KEY || "").trim();
    if (!apiKey) {
      return { ok: false, skipped: true, reason: "gemini_not_configured" };
    }

    const response = await fetchImpl(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.3,
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        ok: false,
        reason: "gemini_http_error",
        status: response.status,
        body,
      };
    }

    const data = await response.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) {
      return { ok: false, reason: "empty_response" };
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "invalid_json", raw };
    }

    const reply = String(parsed.reply || parsed.suggestedReply || "").trim();
    const pathForward = String(
      parsed.pathForward || parsed.path_forward || parsed.nextStep || "",
    ).trim();
    if (!reply) {
      return { ok: false, reason: "missing_reply", parsed };
    }

    const suggestion = pathForward
      ? `${reply}\n\n— Path forward: ${pathForward}`
      : reply;
    return { ok: true, suggestion, reply, pathForward };
  }

  function buildPrompt(ticket, messages = []) {
    const thread = messages
      .map((m) => `[${m.author_type}] ${m.body}`)
      .join("\n\n");
    return `You help ShelfMapper support staff draft replies. Never claim refunds were issued or policies changed. Be concise, empathetic, and practical.

Return ONLY JSON:
{
  "reply": "suggested email/chat reply the admin can send",
  "pathForward": "one short sentence for the admin on next steps"
}

Ticket category: ${ticket.category}
Subject: ${ticket.subject}
Customer email: ${ticket.email}

Original message:
${ticket.body}

Thread so far:
${thread || "(none)"}`;
  }

  async function generateSuggestion(ticketId) {
    const { data: ticket, error } = await supabase
      .from("support_tickets")
      .select(
        "id,public_id,email,category,subject,body,status,ai_suggestion,ai_suggestion_status",
      )
      .eq("id", ticketId)
      .maybeSingle();
    if (error || !ticket) {
      throw new Error(error?.message || "Ticket not found");
    }

    await supabase
      .from("support_tickets")
      .update({
        ai_suggestion_status: "pending",
        updated_at: new Date().toISOString(),
      })
      .eq("id", ticketId);

    const { data: messages } = await supabase
      .from("support_ticket_messages")
      .select("author_type,body,created_at")
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: true })
      .limit(40);

    let result;
    try {
      result = await callGemini(buildPrompt(ticket, messages || []));
    } catch (error) {
      result = { ok: false, reason: error?.message || "gemini_exception" };
    }

    if (result.skipped) {
      await supabase
        .from("support_tickets")
        .update({
          ai_suggestion: null,
          ai_suggestion_status: "skipped",
          ai_suggestion_generated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", ticketId);
      return { status: "skipped", reason: result.reason };
    }

    if (!result.ok) {
      console.error("support-ai: generation failed", result.reason);
      await supabase
        .from("support_tickets")
        .update({
          ai_suggestion_status: "failed",
          ai_suggestion_generated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", ticketId);
      return { status: "failed", reason: result.reason };
    }

    await supabase
      .from("support_tickets")
      .update({
        ai_suggestion: result.suggestion,
        ai_suggestion_status: "ready",
        ai_suggestion_generated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", ticketId);

    return {
      status: "ready",
      suggestion: result.suggestion,
    };
  }

  function kickOffSuggestion(ticketId) {
    setImmediate(() => {
      generateSuggestion(ticketId).catch((error) => {
        console.error(
          "support-ai: background suggest failed",
          error?.message || error,
        );
      });
    });
  }

  return {
    generateSuggestion,
    kickOffSuggestion,
    callGemini,
    buildPrompt,
  };
}

module.exports = {
  createSupportAi,
  GEMINI_MODEL,
};
