require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────
// DYNAMIC CONFIG
// ─────────────────────────────────────────────
let jiraConfig = {
  baseUrl: process.env.JIRA_BASE_URL  || "",
  email:   process.env.JIRA_EMAIL     || "",
  token:   process.env.JIRA_API_TOKEN || "",
};
let slackConfig = {
  token:  process.env.SLACK_BOT_TOKEN || "",
  teamId: process.env.SLACK_TEAM_ID   || "",
};
let qaseConfig = {
  token:   process.env.QASE_API_TOKEN || "",
  project: process.env.QASE_PROJECT   || "",
  baseUrl: process.env.QASE_BASE_URL  || "https://api.qase.io",
};
let cicdConfig = {
  webhookUrl:      process.env.CICD_WEBHOOK_URL      || "",
  payloadTemplate: process.env.CICD_PAYLOAD_TEMPLATE || '{"event":"deploy"}',
};

const JIRA_MAX_RESULTS = parseInt(process.env.JIRA_MAX_RESULTS) || 50;
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || "";

let githubToken = process.env.GITHUB_TOKEN || "";

// ─────────────────────────────────────────────
// AI PROVIDER CONFIGURATION (with fallback)
// ─────────────────────────────────────────────
const AI_PROVIDERS = [
  {
    name: "Groq",
    enabled: !!process.env.GROQ_API_KEY,
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    key: process.env.GROQ_API_KEY,
    headers: (key) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" }),
  },
  {
    name: "DeepSeek",
    enabled: !!process.env.DEEPSEEK_API_KEY,
    url: "https://api.deepseek.com/v1/chat/completions",
    model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    key: process.env.DEEPSEEK_API_KEY,
    headers: (key) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" }),
  },
  {
    name: "OpenAI",
    enabled: !!process.env.OPENAI_API_KEY,
    url: "https://api.openai.com/v1/chat/completions",
    model: process.env.OPENAI_MODEL || "gpt-3.5-turbo",
    key: process.env.OPENAI_API_KEY,
    headers: (key) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" }),
  },
];

async function callAI(prompt, maxTokens = 6000, temperature = 0.2) {
  const errors = [];
  for (const provider of AI_PROVIDERS) {
    if (!provider.enabled) continue;
    console.log(`🤖 Attempting AI call with ${provider.name} (model: ${provider.model})`);
    try {
      const response = await axios.post(
        provider.url,
        {
          model: provider.model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens,
          temperature: temperature,
        },
        { headers: provider.headers(provider.key), timeout: 60000 }
      );
      const content = response.data.choices[0]?.message?.content;
      if (content) {
        console.log(`✅ AI response received from ${provider.name}`);
        return content;
      } else {
        throw new Error("Empty response from AI");
      }
    } catch (err) {
      const status = err.response?.status;
      const errorMsg = err.response?.data?.error?.message || err.message;
      console.warn(`⚠️ ${provider.name} failed: ${errorMsg} (status ${status})`);
      errors.push(`${provider.name}: ${errorMsg}`);
    }
  }
  throw new Error(`All AI providers failed: ${errors.join("; ")}`);
}

// ─────────────────────────────────────────────
// AXIOS HELPERS
// ─────────────────────────────────────────────
function getJiraAxios() {
  const auth = Buffer.from(`${jiraConfig.email}:${jiraConfig.token}`).toString("base64");
  return axios.create({
    baseURL: `${jiraConfig.baseUrl.replace(/\/$/, "")}/rest/api/3`,
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json", "Content-Type": "application/json" },
  });
}
function getSlackAxios() {
  return axios.create({
    baseURL: "https://slack.com/api",
    headers: { Authorization: `Bearer ${slackConfig.token}`, "Content-Type": "application/json" },
  });
}
function getQaseAxios() {
  const base = qaseConfig.baseUrl.replace(/\/$/, "");
  return axios.create({
    baseURL: `${base}/v1`,
    headers: { Token: qaseConfig.token, "Content-Type": "application/json" },
  });
}
function updateEnvFile(updates) {
  const envPath = path.join(__dirname, ".env");
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  Object.entries(updates).forEach(([key, value]) => {
    const regex = new RegExp(`^${key}=.*$`, "m");
    content = regex.test(content) ? content.replace(regex, `${key}=${value}`) : content + `\n${key}=${value}`;
  });
  fs.writeFileSync(envPath, content, "utf8");
}
function extractTextFromADF(adf) {
  if (!adf) return "";
  if (typeof adf === "string") return adf;
  let text = "";
  function traverse(node) {
    if (!node) return;
    if (node.type === "text") text += node.text || "";
    if (node.type === "hardBreak" || node.type === "paragraph") text += "\n";
    if (node.content) node.content.forEach(traverse);
  }
  traverse(adf);
  return text.trim();
}

// ─────────────────────────────────────────────
// ROUTES — HEALTH
// ─────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  const activeProviders = AI_PROVIDERS.filter(p => p.enabled).map(p => p.name);
  res.json({ status: "ok", activeAIProviders: activeProviders, jira: !!jiraConfig.token, slack: !!slackConfig.token, qase: !!qaseConfig.token });
});

// ─────────────────────────────────────────────
// JIRA CONFIG
// ─────────────────────────────────────────────
app.get("/api/config/jira", (req, res) => {
  res.json({ success: true, config: { baseUrl: jiraConfig.baseUrl, email: jiraConfig.email, hasToken: !!jiraConfig.token } });
});
app.post("/api/config/jira", (req, res) => {
  try {
    const { baseUrl, email, token } = req.body;
    if (!baseUrl || !email || !token) return res.status(400).json({ success: false, error: "All three fields are required" });
    jiraConfig = { baseUrl: baseUrl.replace(/\/$/, ""), email: email.trim(), token: token.trim() };
    updateEnvFile({ JIRA_BASE_URL: jiraConfig.baseUrl, JIRA_EMAIL: jiraConfig.email, JIRA_API_TOKEN: jiraConfig.token });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.get("/api/config/jira/test", async (req, res) => {
  try {
    if (!jiraConfig.token) return res.status(400).json({ success: false, error: "Please save config first" });
    const r = await getJiraAxios().get("/myself");
    res.json({ success: true, user: r.data.displayName, email: r.data.emailAddress });
  } catch { res.status(400).json({ success: false, error: "Invalid Jira credentials" }); }
});

// ─────────────────────────────────────────────
// SLACK CONFIG
// ─────────────────────────────────────────────
app.get("/api/config/slack", (req, res) => {
  res.json({ success: true, config: { hasToken: !!slackConfig.token, teamId: slackConfig.teamId } });
});
app.post("/api/config/slack", (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false, error: "Slack Bot Token is required" });
    slackConfig.token = token.trim();
    updateEnvFile({ SLACK_BOT_TOKEN: slackConfig.token });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.get("/api/config/slack/test", async (req, res) => {
  try {
    if (!slackConfig.token) return res.status(400).json({ success: false, error: "Please save Slack token first" });
    const r = await getSlackAxios().get("/auth.test");
    if (!r.data.ok) return res.status(400).json({ success: false, error: r.data.error });
    slackConfig.teamId = r.data.team_id;
    updateEnvFile({ SLACK_TEAM_ID: r.data.team_id });
    res.json({ success: true, user: r.data.user, team: r.data.team, teamId: r.data.team_id });
  } catch { res.status(400).json({ success: false, error: "Invalid Slack token" }); }
});

// ─────────────────────────────────────────────
// QASE CONFIG
// ─────────────────────────────────────────────
app.get("/api/config/qase", (req, res) => {
  res.json({ success: true, config: { token: qaseConfig.token, project: qaseConfig.project, baseUrl: qaseConfig.baseUrl } });
});
app.post("/api/config/qase", (req, res) => {
  try {
    const { token, project, baseUrl } = req.body;
    if (!token || !project) return res.status(400).json({ success: false, error: "Token and Project Code required" });
    qaseConfig = { 
      token: token.trim(), 
      project: project.trim().toUpperCase(), 
      baseUrl: (baseUrl?.trim() || "https://api.qase.io").replace(/\/$/, "") 
    };
    updateEnvFile({ QASE_API_TOKEN: qaseConfig.token, QASE_PROJECT: qaseConfig.project, QASE_BASE_URL: qaseConfig.baseUrl });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post("/api/config/qase/test", async (req, res) => {
  let { token, project, baseUrl } = req.body;
  if (!token || !project) {
    return res.status(400).json({ success: false, error: "Token and Project required" });
  }
  const effectiveBase = (baseUrl || qaseConfig.baseUrl || "https://api.qase.io").replace(/\/$/, "");
  project = project.trim().toUpperCase();
  console.log(`Testing Qase: ${effectiveBase}/v1/project/${project}`);
  try {
    const response = await axios.get(`${effectiveBase}/v1/project/${project}`, {
      headers: { Token: token, "Content-Type": "application/json" }
    });
    if (response.data && response.data.status === true) {
      res.json({ success: true, result: response.data.result });
    } else {
      res.status(400).json({ success: false, error: response.data.errorMessage || "Invalid response" });
    }
  } catch (err) {
    console.error("Qase test error:", err.response?.status, err.response?.data);
    const detail = err.response?.data?.errorMessage || err.response?.data?.message || err.message;
    res.status(400).json({ success: false, error: `Qase error: ${detail}` });
  }
});

// ─────────────────────────────────────────────
// CI/CD CONFIG
// ─────────────────────────────────────────────
app.get("/api/config/cicd", (req, res) => {
  res.json({
    success: true,
    config: { webhookUrl: cicdConfig.webhookUrl, payloadTemplate: cicdConfig.payloadTemplate },
    githubToken: githubToken
  });
});

app.post("/api/config/cicd", (req, res) => {
  try {
    const { webhookUrl, payloadTemplate, githubToken: newToken } = req.body;
    cicdConfig = { webhookUrl: webhookUrl || "", payloadTemplate: payloadTemplate || '{"event":"deploy"}' };
    if (newToken !== undefined) githubToken = newToken.trim();
    updateEnvFile({
      CICD_WEBHOOK_URL: cicdConfig.webhookUrl,
      CICD_PAYLOAD_TEMPLATE: cicdConfig.payloadTemplate,
      GITHUB_TOKEN: githubToken
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─────────────────────────────────────────────
// SLACK CREATE JIRA ISSUE (ENHANCED WITH AI STEPS)
// ─────────────────────────────────────────────
app.post("/api/slack/create-jira", async (req, res) => {
  try {
    if (!jiraConfig.token) return res.status(400).json({ success: false, error: "Jira not configured" });
    const { message } = req.body;
    if (!message || !message.text) return res.status(400).json({ success: false, error: "Invalid Slack message" });

    // Step 1: Call AI to analyse the Slack message and generate structured test steps & risk analysis
    const analysisPrompt = buildSlackQAPrompt(message);
    let analysis = null;
    try {
      const rawAnalysis = await callAI(analysisPrompt, 4000, 0.2);
      const match = rawAnalysis.match(/```json\s*([\s\S]*?)\s*```/) ||
                    rawAnalysis.match(/```\s*([\s\S]*?)\s*```/)     ||
                    rawAnalysis.match(/(\{[\s\S]*\})/);
      analysis = JSON.parse(match ? match[1] : rawAnalysis);
    } catch (err) {
      console.warn("AI analysis failed for Jira creation, falling back to basic description:", err.message);
      analysis = null;
    }

    // Build a rich ADF description
    const descriptionContent = [];

    // Heading: Original Slack Message
    descriptionContent.push(
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Slack Message" }] },
      { type: "paragraph", content: [{ type: "text", text: "From: ", marks: [{ type: "strong" }] }, { type: "text", text: message.user }, { type: "text", text: "  |  Channel: " }, { type: "text", text: message.channel, marks: [{ type: "strong" }] }, { type: "text", text: "  |  Time: " }, { type: "text", text: message.time, marks: [{ type: "strong" }] }] },
      { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Original Content" }] },
      { type: "paragraph", content: [{ type: "text", text: message.text }] }
    );

    // If AI analysis succeeded, add detailed test cases and steps
    if (analysis && analysis.testCases && analysis.testCases.length > 0) {
      descriptionContent.push(
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "AI-Generated Test Steps & Expected Results" }] },
        { type: "paragraph", content: [{ type: "text", text: analysis.summary || "Summary of the bug/feature:", marks: [{ type: "strong" }] }] },
        { type: "paragraph", content: [{ type: "text", text: analysis.summary || "No summary provided." }] },
        { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Test Cases" }] }
      );

      for (const tc of analysis.testCases) {
        descriptionContent.push(
          { type: "heading", attrs: { level: 4 }, content: [{ type: "text", text: `${tc.id}: ${tc.title} (${tc.priority} priority, ${tc.type})` }] },
          { type: "paragraph", content: [{ type: "text", text: "Preconditions:", marks: [{ type: "strong" }] }] },
          { type: "paragraph", content: [{ type: "text", text: tc.preconditions || "None" }] },
          { type: "paragraph", content: [{ type: "text", text: "Test Data:", marks: [{ type: "strong" }] }] },
          { type: "paragraph", content: [{ type: "text", text: tc.testData || "None" }] },
          { type: "paragraph", content: [{ type: "text", text: "Steps:", marks: [{ type: "strong" }] }] }
        );
        const stepsList = tc.steps.map((step, idx) => `${idx+1}. ${step}`).join('\n');
        descriptionContent.push({ type: "paragraph", content: [{ type: "text", text: stepsList }] });
        descriptionContent.push(
          { type: "paragraph", content: [{ type: "text", text: "Expected Result:", marks: [{ type: "strong" }] }] },
          { type: "paragraph", content: [{ type: "text", text: tc.expectedResult }] }
        );
      }

      // Add risk areas if available
      if (analysis.riskAreas && analysis.riskAreas.length > 0) {
        descriptionContent.push({ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Risk Analysis" }] });
        for (const risk of analysis.riskAreas) {
          descriptionContent.push(
            { type: "paragraph", content: [{ type: "text", text: `${risk.area} (${risk.severity} severity):`, marks: [{ type: "strong" }] }] },
            { type: "paragraph", content: [{ type: "text", text: risk.description }] },
            { type: "paragraph", content: [{ type: "text", text: "Mitigation:", marks: [{ type: "em" }] }, { type: "text", text: ` ${risk.mitigation}` }] }
          );
        }
      }

      // Add recommendations
      if (analysis.recommendations && analysis.recommendations.length > 0) {
        descriptionContent.push({ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Recommendations" }] });
        const recs = analysis.recommendations.map(r => `• ${r}`).join('\n');
        descriptionContent.push({ type: "paragraph", content: [{ type: "text", text: recs }] });
      }
    } else {
      // Fallback to original description if AI failed
      descriptionContent.push(
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Details" }] },
        { type: "paragraph", content: [{ type: "text", text: message.text }] }
      );
      if (message.reactions && message.reactions.length > 0) {
        descriptionContent.push(
          { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Reactions" }] },
          { type: "paragraph", content: [{ type: "text", text: message.reactions.map(r => `:${r.name}: ${r.count}`).join(", ") }] }
        );
      }
      if (message.replyCount) {
        descriptionContent.push(
          { type: "paragraph", content: [{ type: "text", text: `💬 Thread replies: ${message.replyCount}`, marks: [{ type: "strong" }] }] }
        );
      }
    }

    const description = {
      version: 1,
      type: "doc",
      content: descriptionContent
    };

    // Clean summary: remove newlines, trim, limit length
    let rawSummary = `[Slack] ${message.user}: ${message.text}`;
    let summary = rawSummary.replace(/\n/g, ' ').replace(/\r/g, ' ').trim();
    if (summary.length > 255) summary = summary.substring(0, 252) + '...';

    const jira = getJiraAxios();

    // Get project key (handles both Jira Cloud and Server)
    let projectKey = JIRA_PROJECT_KEY;
    if (!projectKey) {
      const projectsResponse = await jira.get("/project");
      const projects = Array.isArray(projectsResponse.data) 
        ? projectsResponse.data 
        : projectsResponse.data.values || [];
      if (projects.length === 0) throw new Error("No Jira projects available");
      projectKey = projects[0].key;
    }
    if (!projectKey) throw new Error("Could not determine Jira project key");

    const payload = {
      fields: {
        project: { key: projectKey },
        summary: summary,
        description: description,
        issuetype: { name: "Bug" },
        priority: { name: "Medium" }
      }
    };

    const response = await jira.post("/issue", payload);
    res.json({ success: true, key: response.data.key, url: `${jiraConfig.baseUrl}/browse/${response.data.key}` });
  } catch (err) {
    console.error("Jira creation error:", err.response?.data || err.message);
    const errorMessage = err.response?.data?.errors 
      ? JSON.stringify(err.response.data.errors) 
      : (err.response?.data?.errorMessages?.join(", ") || err.message);
    res.status(500).json({ success: false, error: errorMessage });
  }
});

// ─────────────────────────────────────────────
// QASE PUSH TEST CASES
// ─────────────────────────────────────────────
app.post("/api/qase/testcases", async (req, res) => {
  try {
    if (!qaseConfig.token || !qaseConfig.project) {
      return res.status(400).json({ success: false, error: "Qase not configured. Save token and project first." });
    }
    let { testCases } = req.body;
    if (!testCases || !testCases.length) {
      return res.status(400).json({ success: false, error: "No test cases provided" });
    }

    testCases = testCases.map(tc => ({
      title: tc.title || "Untitled",
      preconditions: tc.preconditions || "None",
      testData: tc.testData || "None",
      steps: Array.isArray(tc.steps) ? tc.steps : (tc.steps ? [tc.steps] : []),
      expectedResult: tc.expectedResult || "Not specified",
      priority: (tc.priority || "Medium").toLowerCase() === "high" ? "High" : (tc.priority || "Medium").toLowerCase() === "low" ? "Low" : "Medium"
    }));

    const qase = getQaseAxios();
    let created = 0;
    const errors = [];

    for (const tc of testCases) {
      const payload = {
        title: tc.title,
        description: `**Preconditions:** ${tc.preconditions}\n**Test Data:** ${tc.testData}\n**Steps:**\n${tc.steps.map((s, i) => `${i+1}. ${s}`).join("\n")}\n**Expected Result:** ${tc.expectedResult}`,
        priority: tc.priority === "High" ? 2 : (tc.priority === "Medium" ? 3 : 4),
        severity: tc.priority === "High" ? 2 : 3,
        type: 1,
      };
      try {
        const response = await qase.post(`/case/${qaseConfig.project}`, payload);
        if (response.data?.status === true) {
          created++;
          console.log(`✅ Created: ${tc.title}`);
        } else {
          const errMsg = response.data?.errorMessage || "Unknown Qase error";
          errors.push(`${tc.title}: ${errMsg}`);
          console.log(`❌ Failed: ${errMsg}`);
        }
      } catch (err) {
        const msg = err.response?.data?.errorMessage || err.response?.data?.message || err.message;
        errors.push(`${tc.title}: ${msg}`);
        console.error(`❌ Exception: ${tc.title}`, msg);
      }
    }

    if (created === 0 && errors.length) {
      return res.status(500).json({ success: false, error: errors.join("; ") });
    }
    res.json({ success: true, count: created, project: qaseConfig.project, warnings: errors });
  } catch (err) {
    console.error("Unexpected error in push endpoint:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// CI/CD TRIGGER
// ─────────────────────────────────────────────
app.post("/api/cicd/trigger", async (req, res) => {
  try {
    const { webhookUrl, payload } = req.body;
    let targetUrl = webhookUrl || cicdConfig.webhookUrl;
    if (!targetUrl) return res.status(400).json({ success: false, error: "CI/CD webhook not configured" });

    let payloadObj = payload;
    if (!payloadObj && cicdConfig.payloadTemplate) {
      try { 
        payloadObj = JSON.parse(cicdConfig.payloadTemplate); 
      } catch (e) { 
        payloadObj = { event_type: "deploy-from-qa-twin" }; 
      }
    } else if (!payloadObj) {
      payloadObj = { event_type: "deploy-from-qa-twin" };
    }

    const headers = { "Content-Type": "application/json" };
    if (targetUrl.includes("api.github.com") && githubToken) {
      headers["Authorization"] = `Bearer ${githubToken}`;
      console.log("🔑 Using GitHub token for authentication");
    }

    const response = await axios.post(targetUrl, payloadObj, { headers });
    res.json({ success: true, message: "Deployment webhook triggered", status: response.status });
  } catch (err) {
    console.error("Webhook error:", err.response?.status, err.response?.data || err.message);
    const errorMsg = err.response?.data?.message || err.message;
    res.status(500).json({ success: false, error: `Request failed: ${errorMsg}` });
  }
});

// ─────────────────────────────────────────────
// SLACK DATA
// ─────────────────────────────────────────────
app.get("/api/slack/channels", async (req, res) => {
  try {
    if (!slackConfig.token) return res.status(400).json({ success: false, error: "SLACK_CONFIG_MISSING" });
    const r = await getSlackAxios().get("/conversations.list", {
      params: { types: "public_channel,private_channel", limit: 100, exclude_archived: true },
    });
    if (!r.data.ok) return res.status(400).json({ success: false, error: r.data.error });
    res.json({ success: true, channels: r.data.channels.map(c => ({ id: c.id, name: c.name, topic: c.topic?.value || "", memberCount: c.num_members || 0, isPrivate: c.is_private })) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/slack/messages/:channelId", async (req, res) => {
  try {
    if (!slackConfig.token) return res.status(400).json({ success: false, error: "SLACK_CONFIG_MISSING" });
    const { channelId } = req.params;
    const { search = "" } = req.query;
    const r = await getSlackAxios().get("/conversations.history", { params: { channel: channelId, limit: 50 } });
    if (!r.data.ok) return res.status(400).json({ success: false, error: r.data.error });
    const userCache = {};
    async function getUsername(userId) {
      if (!userId) return "Unknown";
      if (userCache[userId]) return userCache[userId];
      try {
        const u = await getSlackAxios().get("/users.info", { params: { user: userId } });
        const name = u.data.user?.real_name || u.data.user?.name || userId;
        userCache[userId] = name;
        return name;
      } catch { return userId; }
    }
    let messages = r.data.messages.filter(m => m.type === "message" && m.text && !m.subtype);
    if (search) messages = messages.filter(m => m.text.toLowerCase().includes(search.toLowerCase()));
    const enriched = await Promise.all(messages.map(async (m) => ({
      id: m.ts, ts: m.ts, text: m.text,
      user: await getUsername(m.user),
      replyCount: m.reply_count || 0,
      reactions: (m.reactions || []).map(rx => ({ name: rx.name, count: rx.count })),
      hasThread: !!m.thread_ts && m.reply_count > 0,
      time: new Date(parseFloat(m.ts) * 1000).toISOString(),
    })));
    res.json({ success: true, messages: enriched, channelId });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─────────────────────────────────────────────
// JIRA ISSUES
// ─────────────────────────────────────────────
app.get("/api/issues", async (req, res) => {
  try {
    if (!jiraConfig.token) return res.status(400).json({ success: false, error: "JIRA_CONFIG_MISSING" });
    const { search = "", priority = "", status = "" } = req.query;
    let jqlParts = [];
    if (JIRA_PROJECT_KEY) jqlParts.push(`project = "${JIRA_PROJECT_KEY}"`);
    else jqlParts.push("project is not EMPTY");
    if (search)   jqlParts.push(`(summary ~ "${search}" OR description ~ "${search}")`);
    if (priority) jqlParts.push(`priority = "${priority}"`);
    if (status)   jqlParts.push(`status = "${status}"`);
    const finalJql = jqlParts.join(" AND ") + " ORDER BY created DESC";
    const response = await getJiraAxios().get("/search/jql", {
      params: { jql: finalJql, maxResults: JIRA_MAX_RESULTS, fields: "summary,description,issuetype,priority,status,assignee,reporter,created,updated,labels,components,comment" },
    });
    const issues = response.data.issues.map(issue => ({
      id: issue.id, key: issue.key,
      summary: issue.fields.summary,
      description: extractTextFromADF(issue.fields.description),
      type: issue.fields.issuetype?.name || "Unknown",
      priority: issue.fields.priority?.name || "Medium",
      status: issue.fields.status?.name || "Open",
      assignee: issue.fields.assignee?.displayName || "Unassigned",
      reporter: issue.fields.reporter?.displayName || "Unknown",
      created: issue.fields.created, updated: issue.fields.updated,
      labels: issue.fields.labels || [],
      components: (issue.fields.components || []).map(c => c.name),
      commentCount: issue.fields.comment?.total || 0,
      url: `${jiraConfig.baseUrl}/browse/${issue.key}`,
    }));
    res.json({ success: true, total: response.data.total, issues });
  } catch (err) {
    res.status(500).json({ success: false, error: err.response?.data?.errorMessages?.[0] || err.message });
  }
});

app.get("/api/issues/:key", async (req, res) => {
  try {
    const response = await getJiraAxios().get(`/issue/${req.params.key}`, {
      params: { fields: "summary,description,issuetype,priority,status,assignee,reporter,created,updated,labels,components,comment,subtasks" },
    });
    const issue = response.data;
    res.json({
      success: true,
      issue: {
        id: issue.id, key: issue.key,
        summary: issue.fields.summary,
        description: extractTextFromADF(issue.fields.description),
        type: issue.fields.issuetype?.name || "Unknown",
        priority: issue.fields.priority?.name || "Medium",
        status: issue.fields.status?.name || "Open",
        assignee: issue.fields.assignee?.displayName || "Unassigned",
        reporter: issue.fields.reporter?.displayName || "Unknown",
        created: issue.fields.created, updated: issue.fields.updated,
        labels: issue.fields.labels || [],
        components: (issue.fields.components || []).map(c => c.name),
        comments: (issue.fields.comment?.comments || []).slice(-5).map(c => ({
          author: c.author?.displayName, body: extractTextFromADF(c.body), created: c.created,
        })),
        url: `${jiraConfig.baseUrl}/browse/${issue.key}`,
      },
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─────────────────────────────────────────────
// AI ANALYSE (using multi-provider callAI)
// ─────────────────────────────────────────────
app.post("/api/analyse", async (req, res) => {
  try {
    const { issue, source } = req.body;
    if (!issue) return res.status(400).json({ success: false, error: "Issue data required" });

    let prompt;
    if (source === "slack") {
      prompt = buildSlackQAPrompt(issue);
    } else if (source === "voice") {
      prompt = buildVoiceQAPrompt(issue);
    } else {
      prompt = buildJiraQAPrompt(issue);
    }

    const rawText = await callAI(prompt, 6000, 0.2);
    let analysis;
    try {
      const match = rawText.match(/```json\s*([\s\S]*?)\s*```/) ||
                    rawText.match(/```\s*([\s\S]*?)\s*```/)     ||
                    rawText.match(/(\{[\s\S]*\})/);
      analysis = JSON.parse(match ? match[1] : rawText);
    } catch {
      analysis = { raw: rawText, summary: "Analysis complete", riskLevel: "Medium" };
    }
    res.json({ success: true, analysis });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// VOICE PROMPT
// ─────────────────────────────────────────────
function buildVoiceQAPrompt(issue) {
  return `You are a senior QA Engineer. Convert the following voice‑transcribed test scenario into structured test cases. Return ONLY valid JSON.

Voice scenario: ${issue.description || issue.summary}

Return this exact JSON structure:
{
  "summary": "Brief summary of what the voice scenario describes",
  "riskLevel": "Critical|High|Medium|Low",
  "riskRationale": "Why this risk level",
  "testCases": [
    {
      "id": "TC001",
      "title": "Clear test case title",
      "type": "Functional|Integration|UI|Performance|Security|Regression",
      "priority": "High|Medium|Low",
      "preconditions": "Any setup needed",
      "steps": ["Step 1", "Step 2", "Step 3"],
      "expectedResult": "What should happen",
      "testData": "Any required data"
    }
  ],
  "riskAreas": [
    {
      "area": "Risk area",
      "description": "Risk description",
      "severity": "High|Medium|Low",
      "mitigation": "How to mitigate"
    }
  ],
  "automationAnalysis": {
    "automatable": true,
    "automationScore": 85,
    "recommendedFrameworks": ["Playwright", "Cucumber"],
    "automationCandidates": ["Test cases suitable for automation"],
    "challenges": ["Potential challenges"],
    "estimatedEffort": "X hours",
    "cucumberFeature": "Feature: ...\\n\\n  Scenario: ...\\n    Given ...",
    "playwrightSteps": "const { Given, When, Then } = require('@cucumber/cucumber');\\n// step definitions"
  },
  "edgeCases": ["Edge case 1", "Edge case 2"],
  "testEnvironments": ["Chrome", "Firefox", "Safari"],
  "estimatedTestingTime": "X hours",
  "recommendations": ["Recommendation"],
  "checklistItems": [
    { "item": "Checklist item", "category": "Functional" }
  ]
}`;
}

// ─────────────────────────────────────────────
// FLAKINESS DETECTION
// ─────────────────────────────────────────────
app.post("/api/analyse/flakiness", async (req, res) => {
  try {
    const { logText } = req.body;
    if (!logText) {
      return res.status(400).json({ success: false, error: "No log text provided" });
    }

    const prompt = `You are a QA automation expert. Analyse the following test execution log and identify which tests are potentially flaky (i.e., they sometimes pass, sometimes fail without code change). Return ONLY a valid JSON object with a "flakyTests" array. No markdown, no explanation.

Log:
${logText}

Return format:
{
  "flakyTests": [
    {
      "testName": "test name",
      "reason": "why it might be flaky",
      "suggestedFix": "how to fix it"
    }
  ]
}

If no flaky tests are found, return {"flakyTests": []}.`;

    const rawText = await callAI(prompt, 3000, 0.2);
    let result;
    try {
      const match = rawText.match(/```json\s*([\s\S]*?)\s*```/) ||
                    rawText.match(/```\s*([\s\S]*?)\s*```/)     ||
                    rawText.match(/(\{[\s\S]*\})/);
      result = JSON.parse(match ? match[1] : rawText);
      if (!result.flakyTests) result.flakyTests = [];
    } catch (e) {
      console.error("Failed to parse AI response for flakiness:", rawText);
      result = { flakyTests: [] };
    }
    res.json({ success: true, flakyTests: result.flakyTests });
  } catch (err) {
    console.error("Flakiness detection error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// PROMPTS (with fixed playwrightSteps)
// ─────────────────────────────────────────────
function buildJiraQAPrompt(issue) {
  return `You are a senior QA Engineer and test automation expert. Analyze this Jira issue and return ONLY a valid JSON object. No markdown, no explanation, just the raw JSON.

IMPORTANT JSON RULES:
- All newlines in code strings must be escaped as \\n
- All double quotes inside strings must be escaped as \\"
- All backslashes must be escaped as \\\\

ISSUE:
- Key: ${issue.key}
- Title: ${issue.summary}
- Type: ${issue.type} | Priority: ${issue.priority} | Status: ${issue.status}
- Reporter: ${issue.reporter} | Assignee: ${issue.assignee}
- Labels: ${issue.labels?.join(", ") || "None"}
- Components: ${issue.components?.join(", ") || "None"}
- Description: ${issue.description || "None"}
${issue.comments?.length ? `- Comments: ${issue.comments.map(c => `${c.author}: ${c.body}`).join(" | ")}` : ""}

Return this exact JSON structure (write real, runnable Playwright + Cucumber code based on the issue):

{
  "summary": "2-3 sentence overview",
  "riskLevel": "Critical|High|Medium|Low",
  "riskRationale": "Why this risk level",
  "testCases": [
    {
      "id": "TC001",
      "title": "Test case title",
      "type": "Functional|Integration|UI|Performance|Security|Regression",
      "priority": "High|Medium|Low",
      "preconditions": "Setup required",
      "steps": ["Step 1", "Step 2", "Step 3"],
      "expectedResult": "What should happen",
      "testData": "Sample data"
    }
  ],
  "riskAreas": [
    {
      "area": "Risk area",
      "description": "Risk description",
      "severity": "High|Medium|Low",
      "mitigation": "How to mitigate"
    }
  ],
  "automationAnalysis": {
    "automatable": true,
    "automationScore": 85,
    "recommendedFrameworks": ["Playwright", "Cucumber"],
    "automationCandidates": ["List of test cases best for automation"],
    "challenges": ["Potential automation challenges"],
    "estimatedEffort": "X hours",
    "cucumberFeature": "Feature: ${issue.summary}\\n\\n  As a QA Engineer\\n  I want to test the functionality\\n  So that I can ensure quality\\n\\n  Background:\\n    Given the application is running\\n    And the user is on the home page\\n\\n  Scenario: TC001 - [scenario title]\\n    Given [precondition]\\n    When [action]\\n    Then [expected result]",
    "playwrightSteps": "const { Given, When, Then, Before, After } = require(\\"@cucumber/cucumber\\");\\nconst { chromium, expect } = require(\\"@playwright/test\\");\\nconst fs = require('fs');\\nconst path = require('path');\\n\\nlet browser, context, page;\\n\\nBefore(async () => {\\n  browser = await chromium.launch({ headless: false });\\n  context = await browser.newContext();\\n  page = await context.newPage();\\n});\\n\\nAfter(async () => {\\n  const screenshotDir = './screenshots';\\n  if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });\\n  const timestamp = Date.now();\\n  await page.screenshot({ path: path.join(screenshotDir, timestamp + '.png'), fullPage: true });\\n  await browser.close();\\n});\\n\\nGiven(\\"the application is running\\", async () => {\\n  await page.goto(process.env.BASE_URL || \\"http://localhost:3000\\");\\n  await expect(page).toHaveTitle(/.*/);\\n});\\n\\nGiven(\\"the user is on the home page\\", async () => {\\n  await page.waitForLoadState(\\"networkidle\\");\\n});"
  },
  "edgeCases": ["Edge case 1", "Edge case 2"],
  "testEnvironments": ["Chrome latest", "Firefox", "Mobile Safari"],
  "dependencies": ["Dependency 1"],
  "estimatedTestingTime": "X hours",
  "recommendations": ["Recommendation 1", "Recommendation 2"],
  "checklistItems": [
    { "item": "Checklist item", "category": "Functional|Performance|Security|UX" }
  ]
}`;
}

function buildSlackQAPrompt(message) {
  return `You are a senior QA Engineer and test automation expert. Analyze this Slack message as a bug report or feature request and return ONLY a valid JSON object. No markdown, no explanation, just the raw JSON.

IMPORTANT JSON RULES:
- All newlines in code strings must be escaped as \\n
- All double quotes inside strings must be escaped as \\"
- All backslashes must be escaped as \\\\

SLACK MESSAGE:
- Channel: ${message.channel}
- From: ${message.user}
- Time: ${message.time}
- Message: ${message.text}
${message.replies?.length ? `- Replies: ${message.replies.map(r => `${r.user}: ${r.text}`).join(" | ")}` : ""}

Return this exact JSON structure (write real, runnable Playwright + Cucumber code based on the message):

{
  "summary": "2-3 sentence overview",
  "riskLevel": "Critical|High|Medium|Low",
  "riskRationale": "Why this risk level",
  "testCases": [
    {
      "id": "TC001",
      "title": "Test case title",
      "type": "Functional|Integration|UI|Performance|Security|Regression",
      "priority": "High|Medium|Low",
      "preconditions": "Setup required",
      "steps": ["Step 1", "Step 2", "Step 3"],
      "expectedResult": "What should happen",
      "testData": "Sample data"
    }
  ],
  "riskAreas": [
    {
      "area": "Risk area",
      "description": "Risk description",
      "severity": "High|Medium|Low",
      "mitigation": "How to mitigate"
    }
  ],
  "automationAnalysis": {
    "automatable": true,
    "automationScore": 80,
    "recommendedFrameworks": ["Playwright", "Cucumber"],
    "automationCandidates": ["List of test cases best for automation"],
    "challenges": ["Potential automation challenges"],
    "estimatedEffort": "X hours",
    "cucumberFeature": "Feature: [feature name from message]\\n\\n  As a QA Engineer\\n  I want to verify the reported issue\\n  So that I can confirm the fix\\n\\n  Background:\\n    Given the application is running\\n\\n  Scenario: TC001 - Reproduce reported issue\\n    Given [precondition based on message]\\n    When [action that triggers the issue]\\n    Then [expected behavior that was reported broken]",
    "playwrightSteps": "const { Given, When, Then, Before, After } = require(\\"@cucumber/cucumber\\");\\nconst { chromium, expect } = require(\\"@playwright/test\\");\\nconst fs = require('fs');\\nconst path = require('path');\\n\\nlet browser, context, page;\\n\\nBefore(async () => {\\n  browser = await chromium.launch({ headless: false });\\n  context = await browser.newContext();\\n  page = await context.newPage();\\n});\\n\\nAfter(async () => {\\n  const screenshotDir = './screenshots';\\n  if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });\\n  const timestamp = Date.now();\\n  await page.screenshot({ path: path.join(screenshotDir, timestamp + '.png'), fullPage: true });\\n  await browser.close();\\n});\\n\\nGiven(\\"the application is running\\", async () => {\\n  await page.goto(process.env.BASE_URL || \\"http://localhost:3000\\");\\n  await expect(page).toHaveTitle(/.*/);\\n});\\n\\nGiven(\\"the user is on the home page\\", async () => {\\n  await page.waitForLoadState(\\"networkidle\\");\\n});"
  },
  "edgeCases": ["Edge case 1", "Edge case 2"],
  "testEnvironments": ["Chrome latest", "Firefox", "Mobile"],
  "dependencies": ["Dependency 1"],
  "estimatedTestingTime": "X hours",
  "recommendations": ["Recommendation 1"],
  "checklistItems": [
    { "item": "Checklist item", "category": "Functional|Performance|Security|UX" }
  ]
}`;
}

// ─────────────────────────────────────────────
// GITHUB PUSH AUTOMATION CODE (uses githubToken)
// ─────────────────────────────────────────────
app.post("/api/github/push", async (req, res) => {
  try {
    if (!githubToken) {
      return res.status(400).json({ success: false, error: "GitHub token not configured in UI or .env" });
    }
    const { owner, repo, branch, path, content, message } = req.body;
    if (!owner || !repo || !branch || !path || content === undefined) {
      return res.status(400).json({ success: false, error: "Missing required fields: owner, repo, branch, path, content" });
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const encodedContent = Buffer.from(content, 'utf8').toString('base64');

    let sha = null;
    try {
      const getRes = await axios.get(url, {
        headers: { Authorization: `Bearer ${githubToken}` },
        params: { ref: branch }
      });
      if (getRes.data && getRes.data.sha) {
        sha = getRes.data.sha;
      }
    } catch (err) {
      if (err.response?.status !== 404) {
        console.warn("Error checking existing file:", err.message);
      }
    }

    const payload = {
      message: message || `Update ${path} from QA Twin`,
      content: encodedContent,
      branch: branch
    };
    if (sha) payload.sha = sha;

    const response = await axios.put(url, payload, {
      headers: { Authorization: `Bearer ${githubToken}`, "Content-Type": "application/json" }
    });

    res.json({ success: true, file: response.data.content.html_url });
  } catch (err) {
    console.error("GitHub push error:", err.response?.data || err.message);
    const errorMsg = err.response?.data?.message || err.message;
    res.status(500).json({ success: false, error: errorMsg });
  }
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 QA AI System → http://localhost:${PORT}`);
  const activeAI = AI_PROVIDERS.filter(p => p.enabled).map(p => p.name).join(", ") || "None";
  console.log(`🤖 Active AI providers: ${activeAI}`);
  console.log(`📋 Jira → ${jiraConfig.baseUrl || "Not configured"}`);
  console.log(`💬 Slack → ${slackConfig.token ? "Configured" : "Not configured"}`);
  console.log(`🧪 Qase → ${qaseConfig.token ? `Configured (${qaseConfig.baseUrl})` : "Not configured"}`);
  console.log(`🚀 CI/CD → ${cicdConfig.webhookUrl ? cicdConfig.webhookUrl : "Not configured"}\n`);
});