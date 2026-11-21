import rss from "@astrojs/rss";
import { getCollection } from "astro:content";
import resume from "../data/resume.json";

export async function GET(context) {
  const posts = (await getCollection("blog", ({ data }) => !data.draft))
    .sort((a, z) => z.data.pubDate.valueOf() - a.data.pubDate.valueOf());
  return rss({
    title: `${resume.basics.name}: blog`,
    description: "Notes on backend engineering, distributed systems and AI platforms.",
    site: context.site,
    items: posts.map((p) => ({
      title: p.data.title,
      description: p.data.description,
      pubDate: p.data.pubDate,
      link: `/blog/${p.id}/`,
    })),
  });
}
