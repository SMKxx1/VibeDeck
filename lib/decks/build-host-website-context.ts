// Grounding context for the "Build & Host Your Own Website" workshop deck.
//
// The deck itself is a self-contained HTML prototype (an iframe), so its slide
// text isn't in the canonical Slide model the AI endpoint reads. This file is
// that missing grounding: one enriched entry per slide — what it shows, the
// point being made, and the analogies/examples used live — so the chat can
// answer a viewer's "wait, what did that mean?" from the actual material.

export interface SlideContext {
  index: number;
  label: string;
  text: string;
}

export const buildHostWebsiteContext: SlideContext[] = [
  {
    index: 0,
    label: "Cover — Build & Host Your Own Website",
    text: "Title slide for the AI Lodge 'Live workshop' called 'Build & Host Your Own Website', described as 'A beginner-friendly workshop to create and publish your first live site.' Three chips summarise the promise: 'No experience — zero coding knowledge required to start', 'Real results — go live with your own URL today', and 'Approach — practical, exciting, and approachable.' A badge reads 'live in ~90 minutes', and an interactive globe on the right ('hover to assemble') animates. The framing: by the end everyone leaves with a real website on the internet and a link they can share, with no coding needed.",
  },
  {
    index: 1,
    label: "Today's journey — four phases (Understand / Build / Launch / Grow)",
    text: "The agenda, titled 'Today's journey', shown as four phase cards. Phase 01 Understand — 'How the web works and the core languages behind every modern page.' Phase 02 Build — 'Leverage AI and modern development tools to craft your unique personal site.' Phase 03 Launch — 'Deploy your project to a live global server for the world to see and visit.' Phase 04 Grow — 'Explore the next steps in your tech journey, from APIs to automation.' It maps the whole session from learning the fundamentals through to publishing and continuing beyond the workshop.",
  },
  {
    index: 2,
    label: "HTML · CSS · JS — three languages, one café page",
    text: "Heading 'Three languages build every webpage', taught by showing the SAME Sunny Cafe menu page three ways. HTML — 'The skeleton': 'Organises the core structure: headings, text, buttons, and images' (a plain, unstyled Times New Roman page). CSS — 'The appearance': 'Defines the visual style: colours, fonts, spacing, and layouts' (the identical content, now beautifully styled). JavaScript — 'The interactivity · try me': 'Powers the action: button clicks, form submissions, and dynamic content' — this pane really works, so you can filter the menu (All / Drinks / Food), Add to order and watch the cart total update, toggle dark mode, and Place order to get 'Thank you! Your order is being prepared.' Footer takeaway: 'Modern websites combine all three to create a complete digital experience.'",
  },
  {
    index: 3,
    label: "Meet the backend — front end / back end / database (live login)",
    text: "Heading 'Meet the backend', using a restaurant analogy across three columns. Frontend = 'the dining room': 'Everything the user sees and interacts with. It's the interface, the layout, and the visual experience' (tags: HTML, CSS, JavaScript) — shown as a live Nimbus login page at nimbus.app/login. Backend = 'the kitchen': 'The behind-the-scenes brain. It processes requests, stores data, and communicates with external AI services' (tags: Python, Node.js, Java, Go) — an auth.py terminal. Database = 'the pantry': 'Holds every account and its data — passwords stored encrypted, never in plain text' (tags: PostgreSQL, MySQL, MongoDB, SQL) — a psql terminal. A sticky note gives the live demo credentials 'user: alice / pass: hunter2'; a correct login returns 'Signed in — welcome, alice' while a wrong one shows 'Incorrect username or password'. A data-flow strip reads User → Frontend → Backend → Database / AI APIs, and the closing note says 'Today's focus: frontend. Future workshops: building capable backends.'",
  },
  {
    index: 4,
    label: "Serverless vs traditional hosting",
    text: "Heading 'Serverless vs traditional hosting', comparing two cards. Traditional hosting ('The old way'): 'Server is always running 24/7', 'Requires manual management', 'Best for massive, complex systems', with a meter showing it is 'Always on — billed all day, visitors or not.' Serverless ('The modern way'): 'Code runs only when needed', 'Zero server management', 'Automatically scales with users' — a 'Visit the site' button triggers a burst of function activity that is 'billed per use', otherwise the cost stays at $0.00. Told live with a kitchen analogy: traditional clouds like AWS and Azure are industrial kitchens (huge power, but you assemble and maintain everything), while Vercel is a fully-equipped home kitchen where you start cooking in minutes; serverless runs on demand then forgets, rather than a machine running 24/7. Closing note: 'Why we use Vercel today — beginner-friendly, fast, and perfect for modern web apps.'",
  },
  {
    index: 5,
    label: "The toolkit — VS Code, GitHub & Vercel (+ AI)",
    text: "Heading 'VS Code, GitHub & Vercel', the three tools that carry the workshop, as numbered tiles. 01 VS Code — 'Write': 'The professional editor where you write and refine your code. Your digital workshop.' 02 GitHub — 'Store': 'A secure home for your projects. It tracks every change and keeps your work safe online.' 03 Vercel — 'Deploy': 'The deployment engine. It takes your code and turns it into a live website for the world.' The slide is interactive — you peel a logo sticker and stick it on the laptop — and a footer flow reads 'Write in VS Code → Store on GitHub → Deploy via Vercel → Live website.' Told live: the AI (Claude or ChatGPT) is your co-pilot the whole way — you direct in plain English and it types.",
  },
  {
    index: 6,
    label: "Hands-on time — the mission (Build / Personalise / Publish / Share)",
    text: "Kicks off the build. Heading 'The mission — build, personalise & publish your first website', with four steps. 01 Build — 'Use AI-assisted coding to generate your site's foundation.' 02 Personalise — 'Add your own content, images, and unique style.' 03 Publish — 'Deploy your project live to the web via Vercel.' 04 Share — 'Get your unique link and share it with the world.' Closing note: 'By the end of today, everyone will have their own live website.'",
  },
  {
    index: 7,
    label: "Quick tool recap (check-in questions)",
    text: "A 'Check-in' slide headed 'Quick tool recap' — three question cards, each with the tool's logo, used to confirm the tools stuck. Question 01 (VS Code): 'What do we use VS Code for?' Question 02 (GitHub): 'What is the main role of GitHub?' Question 03 (Vercel): 'Why do we use Vercel for our site?' Closing note: 'Master the core tools of modern web development.'",
  },
  {
    index: 8,
    label: "From idea to website (interactive pipeline)",
    text: "An interactive walkthrough headed 'From idea to website' (eyebrow: 'The modern development workflow'). Six steps sit along a line and a glowing data packet travels between them as you click each step or press 'Next step ▸' (with a 'Reset' to replay), each stage lighting up with a one-liner: Idea — 'It starts with your concept'; Generate with AI — 'AI writes the first version for you'; Edit in VS Code — 'Refine and tweak the code'; Upload to GitHub — 'Save and version your project'; Deploy with Vercel — 'Publish to a global server'; Live website — 'Your site is live for the world' (ending in a celebratory burst). Note: 'Click any step — or press Next step — to walk the path from concept to a live global presence.'",
  },
  {
    index: 9,
    label: "Showcase your website (paste your live link)",
    text: "The showcase slide, headed 'Showcase your website'. Under 'Paste your live link' there is a text box (placeholder 'https://my-site.vercel.app') and an arrow send button; each submitted link is added to a running list. This is the input step where everyone shares the URL of the site they just built and published, feeding the live pinboard on the next slide (told live: scan to join the gallery, then celebrate and explore the creations together).",
  },
  {
    index: 10,
    label: "The live pinboard (class gallery)",
    text: "Headed 'The live pinboard' (eyebrow: 'The class gallery'), a cork-board wall of everyone's sites. As people paste their links on the previous showcase slide, their cards pin up here, and — as the hint says — you 'Click a card to visit the live site', which opens that live site in a new tab. It's the celebratory gallery of everything the room built.",
  },
  {
    index: 11,
    label: "Continue building with us (what's next)",
    text: "Headed 'Continue building with us' (eyebrow: 'What's next'), six cards for where to go next with AI Lodge. AI Applications — 'Build intelligent applications that interact with advanced AI models to solve complex problems.' API Security — 'Learn to connect services securely, manage sensitive API keys, and protect your user data.' Workflow Automation — 'Automate repetitive tasks and streamline your digital life using powerful tools like n8n.' AI Agents — 'Explore the Model Context Protocol (MCP) and build autonomous agents that act on your behalf.' Knowledge Systems — 'Create Retrieval-Augmented Generation (RAG) apps that use your own documents as a brain.' Your Own Project — 'Apply everything you've learnt to create a real product that solves a problem you care about.' Closing note: 'Practical AI skills for startups, consulting, analytics, and engineering.'",
  },
  {
    index: 12,
    label: "Thank you",
    text: "The closing slide (eyebrow: 'Workshop · Build & Host Your Own Website'): a large 'Thank you!' with the line 'Keep building. Keep creating.' A pill reads 'Questions? We're here to help you on your next steps.' On the right is a large Feedback QR code labelled 'Feedback' / 'Scan to share' for leaving feedback.",
  },
];

export function contextForSlide(index: number): SlideContext | undefined {
  return buildHostWebsiteContext.find((s) => s.index === index);
}

export function fullContextText(): string {
  return buildHostWebsiteContext
    .map((s) => `--- Slide ${s.index + 1}: ${s.label} ---\n${s.text}`)
    .join("\n\n");
}
