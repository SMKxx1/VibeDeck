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
    text: "Title slide for the AI Lodge live workshop 'Build & Host Your Own Website'. A beginner-friendly, ~90-minute session where every attendee creates and publishes their own live website — with a real URL they can share — and no coding knowledge is required. Framing: no experience needed to start; real results (you go live with your own URL today); the approach is practical, exciting and approachable.",
  },
  {
    index: 1,
    label: "Today's journey (agenda)",
    text: "The agenda / roadmap for the session, shown as a row of cards: understand what a website is made of (HTML/CSS/JS), meet the front end vs back end, learn where sites are hosted (servers and serverless like Vercel), meet the toolkit (VS Code, GitHub, Vercel, AI), then a hands-on build, a showcase, and where to continue.",
  },
  {
    index: 2,
    label: "HTML · CSS · JS — one café page, three ways",
    text: "Explains the three languages of the web using the SAME café menu page shown three times. HTML alone = plain content and structure (the skeleton: headings, lists, text). CSS = the identical content but beautifully styled (colours, layout, type — the paint and clothes). JavaScript = the page comes alive and becomes interactive: you can filter the menu (All / Drinks / Food), add items and watch the cart total update, toggle dark mode, and place an order to see a thank-you message. Analogy: HTML is the structure, CSS is the style, JS is the behaviour.",
  },
  {
    index: 3,
    label: "Front end vs back end (live login demo)",
    text: "Explains front end, back end and database with a restaurant analogy and a live login demo. Front end = the dining room: what the user sees and types into (a login page). Back end = the kitchen: code the user never sees that does the work — here an auth.py that checks the password. Database = where the accounts and data live, with passwords stored encrypted. Live demo credentials: log in as alice / hunter2 and follow the request left to right: the front end sends your details, the back end checks them, the database confirms the account.",
  },
  {
    index: 4,
    label: "Serverless vs traditional hosting",
    text: "Explains hosting and why we use Vercel. Traditional cloud (AWS, Azure) is like an industrial kitchen: incredibly powerful, but you assemble and maintain everything yourself. Vercel is like a fully-equipped home kitchen: you start cooking (deploying) in minutes. The twist with serverless: your code runs on demand when someone visits, then forgets — it isn't a machine running 24/7 that you rent and babysit. For everything in this workshop, that on-demand model is more than enough and is effectively free.",
  },
  {
    index: 5,
    label: "The toolkit — VS Code, GitHub, Vercel (+ AI)",
    text: "The three tools that carry the whole workshop, plus the AI co-pilot. VS Code = the editor where you write your website. GitHub = where every version of your code is stored and saved safely (version history). Vercel = where you deploy and host the site so it's live on the internet with a URL. The AI (Claude or ChatGPT) is your co-pilot the whole way: you direct it in plain English and it writes the code. You stay in charge; it types.",
  },
  {
    index: 6,
    label: "Hands-on time — the mission",
    text: "Kicks off the build. The mission in four steps: (1) build your first website with AI, (2) personalise it to make it yours, (3) publish it via Vercel so it's live, (4) share the link. This is where attendees start creating.",
  },
  {
    index: 7,
    label: "Quick tool recap",
    text: "A quick check-in before the hands-on build to make sure the tools stuck: What is VS Code for? (writing/editing your code.) What does GitHub do? (stores and versions your code.) Why Vercel? (deploys and hosts your site live on a URL.)",
  },
  {
    index: 8,
    label: "From idea to website (interactive pipeline)",
    text: "An interactive walkthrough of the publishing pipeline: idea → write code (with AI in VS Code) → save to GitHub → deploy on Vercel → live website. Clicking each step (or Next) advances a data packet along the line and lights up that stage with a one-line explanation; the final step publishes the site with a celebratory burst. It shows how the tools connect end to end.",
  },
  {
    index: 9,
    label: "Showcase — share your live link",
    text: "The showcase slide where everyone shares the link to the website they just built and published. Attendees paste their live URL here to join the gallery; there's also a QR code to scan. This is the input step that feeds the pinboard on the next slide.",
  },
  {
    index: 10,
    label: "Pinboard — everyone's live sites",
    text: "A live pinboard of everyone's websites. As people submit their links on the showcase slide, their cards pin up here, each labelled with the submitter's name, and clicking a card opens that live site in a new tab. It's the celebratory wall of everything the room built.",
  },
  {
    index: 11,
    label: "Continue building — where to go next",
    text: "Where attendees can go next with AI Lodge after this workshop: building AI applications, API security, workflow automation, AI agents, knowledge systems, and bringing their own project. An invitation to keep learning.",
  },
  {
    index: 12,
    label: "Thank you",
    text: "The closing slide: a warm thank-you and encouragement to keep building and keep creating, with a feedback QR code and an offer of help with next steps.",
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
