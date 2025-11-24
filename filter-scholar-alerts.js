/*Config for the script*/
global_config = {
  // How far back each digest should look
  'past_day_range': 4,
  // How many papers to include in one part of the digest, more than 200 tends to hit length limits of emails
  'papers_per_merged_email': 12,
  // Search for the sender of the email
  'senderEmail': 'scholaralerts-noreply@google.com',
  // After sending the digest should the email get marked as unread
  'mark_as_unread': true,
  // Label to mark processed emails (prevents reprocessing)
  'processed_label': 'scholar-alerts-processed'
}

/*Normalize URLs to remove tracking parameters and ensure consistent format*/
function normalize_url(url) {
  if (!url) return '';

  try {
    // Remove common tracking parameters
    var urlObj = new URL(url);
    var paramsToRemove = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
                          'fbclid', 'gclid', 'mc_cid', 'mc_eid', '_ga', 'ref', 'source'];

    paramsToRemove.forEach(param => {
      urlObj.searchParams.delete(param);
    });

    // Normalize protocol to https
    if (urlObj.protocol === 'http:') {
      urlObj.protocol = 'https:';
    }

    // Remove trailing slash
    var normalized = urlObj.toString();
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }

    return normalized;
  } catch (e) {
    // If URL parsing fails, return the original URL
    return url;
  }
}

/*Parse the body for the email which cites papers of a specific author*/
function parse_citations_email(plainBody) {
  var lines = plainBody.split(/\r?\n/);

  // Go over the plain text lines and get the papers title, url, authors, and venue.
  var paper_lines = []
  var raw_papers = []
  var obtained_main_content = false
  var i = 0
  while (i < lines.length){
    var line = lines[i].trim();
    // At the end of the email is a line about why you were sent the email. Skip it.
    if (line.includes('This message was sent by Google Scholar')){
      break
    }
    // If there is a empty line its a new paper
    if (line == ''){
      if (paper_lines.length != 0){
        raw_papers.push(paper_lines)
        // console.log(paper_lines)
      }
      paper_lines = []
      obtained_main_content = false
      i += 1
    }
    else {
      // The "Cites" line comes after the paper title, author, and snippet
      if (line.includes('Cites:')){
        const index = line.indexOf("Cites:");
        paper_lines.push(line.slice(index))
        obtained_main_content = true
      }
      if (!obtained_main_content) {
        paper_lines.push(line)
      }
      i += 1
    }
    //
  }

  // Go over the papers and get their title, url, metadata (authors, venue, year), and snippet
  // This assumes that the google scholar papers contain title, url, author and year
  var parsed_papers = {}
  for (let i = 0; i < raw_papers.length; i++) {
    raw_lines = raw_papers[i]
    // console.log(raw_lines)
    var title_lines = []
    var url_line = ''
    var metadata_lines = []
    var snippet_lines = []
    var got_url = false
    var got_metadata = false
    const metadata_pattern = /\s\d{4}$/;  // Check if a line ends with 4 digits, extracts metadata like author, venue, and year.
    for (let j = 0; j < raw_lines.length; j++){
      line = raw_lines[j]
      if (line.startsWith('<https:')){
        url_line = line.slice(1,-1)
        got_url = true
        continue
      }
      if (!got_url) {
        title_lines.push(line)
      }
      else{
        if (!got_metadata){ // The lines after the url is metadata until the year of publication
          metadata_lines.push(line)
          if (metadata_pattern.test(line)){
            got_metadata = true
          }
        }
        else{
          snippet_lines.push(line)
        }
      }
    }
    title_text = title_lines.join(" ")
    // The metadata and snippet parsing isnt perfect so sometimes the snippet is empty. Swap the two when this happens
    if (snippet_lines.length <= 1){
      metadata_text = ""
      snippet_text = metadata_lines.join(" ")
      cites_text = ""
    } else {
      metadata_text = metadata_lines.join(" ")
      // Keep all the lines except the last for the snippet text
      snippet_text = snippet_lines.slice(0, -1).join(" ")
      // The last line of the snippet says which paper of the author was cited.
      // The cites text can also be cut off - dint bother to get accumulate it to the end because it makes parsing harder
      // Also get rid of the "Cites:" at the start
      cites_text = snippet_lines.slice(-1)[0]
      cites_text = cites_text.slice(6).trim()
    }
    var paper_dict = {
      "title": title_text,
      "url": normalize_url(url_line),
      "metadata": metadata_text,
      "cites": cites_text,
      "snippet": snippet_text
    }
    parsed_papers[title_text] = paper_dict
  }

  return parsed_papers
}

/*Parse the body for "new articles" emails which come as HTML*/
function parse_new_article_email(htmlBody, subject) {
  var parsed_papers = {}

  // Extract title - look for the main title link pattern in Google Scholar emails
  var titleMatch = htmlBody.match(/<h3[^>]*>.*?<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/i);
  if (!titleMatch) {
    // Try alternative pattern
    titleMatch = htmlBody.match(/<a[^>]*class="[^"]*gse_alrt_title[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/i);
  }

  if (titleMatch) {
    var url = titleMatch[1].replace(/&amp;/g, '&'); // Decode HTML entities
    var title = titleMatch[2].replace(/<[^>]*>/g, '').trim(); // Strip HTML tags

    // Extract metadata (authors, venue, year) - usually in a div with specific styling
    var metadata = '';
    var metadataMatch = htmlBody.match(/<div[^>]*color:#006621[^>]*>(.*?)<\/div>/i);
    if (metadataMatch) {
      metadata = metadataMatch[1].replace(/<[^>]*>/g, '').trim();
    }

    // Extract snippet - usually after metadata
    var snippet = '';
    var snippetMatch = htmlBody.match(/<div[^>]*class="[^"]*gse_alrt_sni[^"]*"[^>]*>(.*?)<\/div>/i);
    if (!snippetMatch) {
      // Try alternative pattern for snippet
      snippetMatch = htmlBody.match(/<div[^>]*line-height:17px[^>]*>(.*?)<\/div>/i);
    }
    if (snippetMatch) {
      snippet = snippetMatch[1].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '').trim();
    }

    var normalized_url = normalize_url(url);
    var paper_dict = {
      "title": title,
      "url": normalized_url,
      "metadata": metadata,
      "cites": "", // New articles don't cite anyone
      "snippet": snippet,
      "source": "new_article" // Mark source type
    }

    parsed_papers[normalized_url] = paper_dict; // Use normalized URL as key for better deduplication
  }

  return parsed_papers;
}

/*Unified function to deduplicate and collate papers from all sources (citations and new articles)
Takes citation papers (keyed by author) and new article papers, deduplicates by URL and title, and returns sorted list*/
function collate_all_papers(authorname2parsed_papers, new_article_papers){
  var url2paper = {}
  var url2authors = {}
  var title2url = {} // Track titles to detect duplicates with different URLs

  // Process citation papers (Type 1)
  for (const [authorname, title2parsed_papers] of Object.entries(authorname2parsed_papers)) {
    for (const [title, parsed_paper] of Object.entries(title2parsed_papers)) {
      var url = parsed_paper['url'];
      var paper_title = parsed_paper['title'];

      // Check if we've seen this title before (even with a different URL)
      var existing_url = title2url[paper_title];

      if (existing_url && existing_url in url2paper) {
        // Paper with same title already exists (might have different URL) - merge with existing
        url = existing_url; // Use the existing URL to ensure we merge properly

        if (url in url2authors) {
          url2authors[url].push(authorname);
        } else {
          url2authors[url] = [authorname];
        }

        // Add citation info
        if (parsed_paper['cites'] == ''){
          url2paper[url]['cites'].push(`Cites ${authorname}`);
        } else {
          url2paper[url]['cites'].push(`Cites ${authorname}: ${parsed_paper['cites']}`);
        }
      } else if (url in url2paper) {
        // Paper with same URL already exists, add this author to the citations list
        if (url in url2authors) {
          url2authors[url].push(authorname);
        } else {
          url2authors[url] = [authorname];
        }

        // Add citation info
        if (parsed_paper['cites'] == ''){
          url2paper[url]['cites'].push(`Cites ${authorname}`);
        } else {
          url2paper[url]['cites'].push(`Cites ${authorname}: ${parsed_paper['cites']}`);
        }
      } else {
        // First time seeing this paper (both URL and title)
        url2authors[url] = [authorname];
        url2paper[url] = parsed_paper;
        url2paper[url]['source'] = 'citation';
        title2url[paper_title] = url; // Track this title

        if (parsed_paper['cites'] == ''){
          url2paper[url]['cites'] = [`Cites ${authorname}`];
        } else {
          url2paper[url]['cites'] = [`Cites ${authorname}: ${parsed_paper['cites']}`];
        }
      }
    }
  }

  // Process new article papers (Type 2)
  for (const [url, parsed_paper] of Object.entries(new_article_papers)) {
    var paper_title = parsed_paper['title'];
    var existing_url = title2url[paper_title];

    if (existing_url && existing_url in url2paper) {
      // Paper with same title already exists - merge with existing
      url2paper[existing_url]['source'] = 'both';
    } else if (url in url2paper) {
      // Paper with same URL already exists in citations - just mark that it's also from new articles
      url2paper[url]['source'] = 'both'; // Appears in both citation alerts and new article alerts
    } else {
      // New paper not seen in citations
      url2paper[url] = parsed_paper;
      url2paper[url]['source'] = 'new_article';
      url2paper[url]['cites'] = []; // No citations for new articles
      url2authors[url] = [];
      title2url[paper_title] = url; // Track this title
    }
  }

  // Sort papers: first by number of citations (descending), then by source type
  var sorted_urls = Object.keys(url2paper).sort((a, b) => {
    var a_citation_count = url2authors[a] ? url2authors[a].length : 0;
    var b_citation_count = url2authors[b] ? url2authors[b].length : 0;

    if (a_citation_count !== b_citation_count) {
      return b_citation_count - a_citation_count; // Sort by citation count descending
    }

    // If same citation count, prioritize by source (citation > both > new_article)
    var source_priority = {'citation': 0, 'both': 1, 'new_article': 2};
    return source_priority[url2paper[a]['source']] - source_priority[url2paper[b]['source']];
  });

  var sorted_papers = []
  for (let j = 0; j < sorted_urls.length; j++){
    sorted_papers.push(url2paper[sorted_urls[j]])
  }

  return sorted_papers;
}

/*Given a dictionary with authorname mapped to all the papers citing their work
count up papers which are citing multiple authors and gather one dict*/
function collate_author_papers(authorname2parsed_papers){
  // Gather the papers and the number of times diff authors papers are cited by them
  var title2authors = {}
  var title2updated_parsed_papers = {}
  for (const [authorname, title2parsed_papers] of Object.entries(authorname2parsed_papers)) {
    for (const [title, parsed_paper] of Object.entries(title2parsed_papers)) {
      if (title in title2authors) {
            title2authors[title].push(authorname);
        } else {
            title2authors[title] = [authorname];
        }
      if (title in title2updated_parsed_papers){
        // console.log(parsed_paper['cites'])
        if (parsed_paper['cites'] == ''){ // Only add the cited papers title if it was parsed correctly
          title2updated_parsed_papers[title]['cites'].push(`Cites ${authorname}`);
        } else {
          title2updated_parsed_papers[title]['cites'].push(`Cites ${authorname}: ${parsed_paper['cites']}`);
        }
      } else {
        // console.log(parsed_paper)
        title2updated_parsed_papers[title] = parsed_paper
        if (parsed_paper['cites'] == ''){
          title2updated_parsed_papers[title]['cites'] = [`Cites ${authorname}`];
        } else {
          title2updated_parsed_papers[title]['cites'] = [`Cites ${authorname}: ${parsed_paper['cites']}`];
        }
      }
    }
  }

  // Get the papers sorted in order of the citations.
  // todo: need to sort the single citation papers by author
  var sorted_titles = Object.keys(title2authors).sort((a, b) => {
        // Sort in decreasing order of list length
        return title2authors[b].length - title2authors[a].length;
    })

  var sorted_papers = []
  for (let j = 0; j < sorted_titles.length; j++){
    sorted_papers.push(title2updated_parsed_papers[sorted_titles[j]])
  }

  return sorted_papers
}

/* Format the list of sorted paper dicts*/
function format_citations_email(sorted_paper_dicts, skip_snippet_cites = false) {
    let formatted_papers = '<div style="font-family:arial,sans-serif;font-size:13px;line-height:16px;color:#222;width:100%;max-width:600px">\n';
    formatted_papers += '<h3 style="font-weight:lighter;font-size:18px;line-height:20px;"></h3>\n<h3 style="font-weight:normal;font-size:18px;line-height:20px;"></h3>'

    for (let i = 0; i < sorted_paper_dicts.length; i++) {
        const paper = sorted_paper_dicts[i];

        formatted_papers += `<h3 style="font-weight:normal;margin:0;font-size:17px;line-height:20px;"><a href=${paper.url} class="gse_alrt_title" style="font-size:17px;color:#1a0dab;line-height:22px">${paper.title}</a></h3>`;

        // Add source badge
        if (paper.source === 'new_article') {
          formatted_papers += `<div style="display:inline-block;background-color:#e8f0fe;color:#1967d2;padding:2px 8px;border-radius:3px;font-size:11px;margin:4px 0;">Keyword Alert</div>`;
        } else if (paper.source === 'both') {
          formatted_papers += `<div style="display:inline-block;background-color:#fce8e6;color:#c5221f;padding:2px 8px;border-radius:3px;font-size:11px;margin:4px 4px 4px 0;">Citation Alert</div>`;
          formatted_papers += `<div style="display:inline-block;background-color:#e8f0fe;color:#1967d2;padding:2px 8px;border-radius:3px;font-size:11px;margin:4px 0;">Keyword Alert</div>`;
        } else if (paper.source === 'citation') {
          formatted_papers += `<div style="display:inline-block;background-color:#fce8e6;color:#c5221f;padding:2px 8px;border-radius:3px;font-size:11px;margin:4px 0;">Citation Alert</div>`;
        }

        if (paper.metadata != ''){
          formatted_papers += `<div style="color:#006621;line-height:18px">${paper.metadata}</div>`;
        }
        if (!skip_snippet_cites){  // The script runs into a max email length limit if collating over multiple days
          formatted_snippet = format_snippet_width(paper.snippet, 100)
          formatted_papers += `<div class="gse_alrt_sni" style="line-height:17px">${formatted_snippet}</div>`;
        }
        if (paper.cites && paper.cites.length != 0){
          formatted_papers += '<table cellpadding="0" cellspacing="0" border="0" style="padding:8px 0>'
          if (skip_snippet_cites){ // The script runs into a max email length limit if collating over multiple days
            formatted_papers += `<tr><td style="line-height:18px;font-size:12px;padding-right:8px;" valign="top">•</td><td style="line-height:18px;font-size:12px;mso-padding-alt:8px 0 4px 0;"><span style="mso-text-raise:4px;">Cites: ${paper.cites.length} subscribed authors.</span></td></tr>`
          } else {
            for (let j = 0; j < paper.cites.length; j++) {
              var text_row = `<tr><td style="line-height:18px;font-size:12px;padding-right:8px;" valign="top">•</td><td style="line-height:18px;font-size:12px;mso-padding-alt:8px 0 4px 0;"><span style="mso-text-raise:4px;">${paper.cites[j]}</span></td></tr>`
              formatted_papers += text_row
            }
          }
          formatted_papers += '</table>'
        }
        formatted_papers += '<br>';
    }
    formatted_papers += '</div>'
    return formatted_papers;
}

/*Truncate the snippet to charsPerLine*/
function format_snippet_width(snippet, charsPerLine) {
    let formattedSnippet = '';
    let currentLine = '';
    const words = snippet.split(/\s+/);

    for (let i = 0; i < words.length; i++) {
        if (currentLine.length + words[i].length + 1 <= charsPerLine) {
            currentLine += (currentLine ? ' ' : '') + words[i];
        } else {
            formattedSnippet += currentLine + '<br>';
            currentLine = words[i];
        }
    }

    if (currentLine) {
        formattedSnippet += currentLine;
    }

    return formattedSnippet;
}

/*Send unified digest email with papers from all sources*/
function send_unified_digest(batch_paper_dicts, total_citing_papers, total_authors, total_new_articles, total_unique_papers, batch_idx=0){
  var now = new Date();
  var pretty_now = Utilities.formatDate(now, Session.getScriptTimeZone(), "EEE MMM dd yyyy");
  var paper_body = format_citations_email(batch_paper_dicts)
  var merged_body = '';
  merged_body += '<html><body>';
  merged_body += '<!doctype html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>body{background-color:#fff}.gse_alrt_title{text-decoration:none}.gse_alrt_title:hover{text-decoration:underline} @media screen and (max-width: 599px) {.gse_alrt_sni br{display:none;}}</style></head>'

  // Create summary header
  var summary = `Collated ${total_unique_papers} unique papers`;
  if (total_citing_papers > 0 && total_new_articles > 0) {
    summary += ` (${total_citing_papers} citation alerts to ${total_authors} authors, ${total_new_articles} keyword alerts)`;
  } else if (total_citing_papers > 0) {
    summary += ` (${total_citing_papers} citation alerts to ${total_authors} authors)`;
  } else if (total_new_articles > 0) {
    summary += ` (${total_new_articles} keyword alerts)`;
  }

  if (batch_idx == 0) {
    merged_body += `<h2>${summary}</h2>`;
  } else {
    merged_body += `<h2>${summary} - Part ${batch_idx}, ${batch_paper_dicts.length}/${total_unique_papers}</h2>`;
  }

  merged_body += paper_body
  merged_body += '</body></html>';

  var merged_subject = batch_idx == 0
    ? `Google Scholar Digest for ${pretty_now}`
    : `Google Scholar Digest for ${pretty_now} - Part ${batch_idx}`;

  if (merged_body !== '<html><body></body></html>') {
    GmailApp.sendEmail(Session.getActiveUser().getEmail(), merged_subject, '', {
      htmlBody: merged_body
    });
    Logger.log('Unified digest email sent successfully.');
  } else {
    Logger.log('No matching emails found.');
  }
}

/*Send unified digest in batches if too many papers*/
function batch_send_unified_digest(sorted_paper_dicts, total_citing_papers, total_authors, total_new_articles, total_unique_papers, paper_per_email = 250){
  var start = 0
  var batch_idx = 1
  while (start+paper_per_email < sorted_paper_dicts.length){
    var batch_papers = sorted_paper_dicts.slice(start, start+paper_per_email)
    send_unified_digest(batch_papers, total_citing_papers, total_authors, total_new_articles, total_unique_papers, batch_idx)
    start += paper_per_email
    batch_idx += 1
  }
  if (start < sorted_paper_dicts.length){ // handle the last batch
    var batch_papers = sorted_paper_dicts.slice(start)
    send_unified_digest(batch_papers, total_citing_papers, total_authors, total_new_articles, total_unique_papers, batch_idx)
  }
}

/*Given a batch of paper dicts, format and send them - this can be called from
batch_send_citation_email or mergeRecentScholarAlerts with no batching is needed*/
function send_citation_email(batch_paper_dicts, total_citing_papers, total_authors, total_unique_papers, batch_idx=0){
  var now = new Date();
  var pretty_now = Utilities.formatDate(now, Session.getScriptTimeZone(), "EEE MMM dd yyyy");
  var paper_body = format_citations_email(batch_paper_dicts)
  var merged_citations_body = '';
  merged_citations_body += '<html><body>';
  merged_citations_body += '<!doctype html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>body{background-color:#fff}.gse_alrt_title{text-decoration:none}.gse_alrt_title:hover{text-decoration:underline} @media screen and (max-width: 599px) {.gse_alrt_sni br{display:none;}}</style></head>'
  if (batch_idx == 0){ // If we are batching then batch_idx >= 1 and we will include it in the email.
    merged_citations_body += `<h2>Collated ${total_citing_papers} citations to ${total_authors} authors into ${total_unique_papers} unique papers</h2>`;
  } else {
    merged_citations_body += `<h2>Collated ${total_citing_papers} citations to ${total_authors} authors into ${total_unique_papers} unique papers - Part ${batch_idx}, ${batch_paper_dicts.length}/${total_unique_papers}</h2>`;
  }
  merged_citations_body += paper_body
  merged_citations_body += '</body></html>';
  if (batch_idx == 0){ // If we are batching then batch_idx >= 1 and we will include it in the email.
    var merged_subject = `Google Scholar Author Citations Digest for ${pretty_now}`;
  } else {
    var merged_subject = `Google Scholar Author Citations Digest for ${pretty_now} - Part ${batch_idx}`;
  }
  if (merged_citations_body !== '<html><body></body></html>') {
    GmailApp.sendEmail(Session.getActiveUser().getEmail(), merged_subject, '', {
      htmlBody: merged_citations_body
    });
    // GmailApp.sendEmail(Session.getActiveUser().getEmail(), merged_subject, mergedBody);
    Logger.log('Merged email with recent alerts sent successfully.');
  } else {
    Logger.log('No matching emails found.');
  }
}

/* Send the emails in parts of 200 or so else the script runs into a max email length limit*/
function batch_send_citation_email(sorted_paper_dicts, total_citing_papers, total_authors, total_unique_papers, paper_per_email = 250){
  var start = 0
  var batch_idx = 1
  while (start+paper_per_email < sorted_paper_dicts.length){
    var batch_papers = sorted_paper_dicts.slice(start, start+paper_per_email)
    send_citation_email(batch_papers, total_citing_papers, total_authors, total_unique_papers, batch_idx)
    start += paper_per_email
    batch_idx += 1
  }
  if (start < sorted_paper_dicts.length){ // handle the last batch
    var batch_papers = sorted_paper_dicts.slice(start)
    send_citation_email(batch_papers, total_citing_papers, total_authors, total_unique_papers, batch_idx)
  }
}


function mergeRecentScholarAlerts() {
  // Get or create the processed label
  var label = GmailApp.getUserLabelByName(global_config.processed_label);
  if (!label) {
    label = GmailApp.createLabel(global_config.processed_label);
  }

  // Construct a search query for emails from scholar alerts in the past_day_range
  // Exclude emails that have already been processed
  var now = new Date();
  var start_date = new Date(now);
  start_date.setDate(now.getDate() - global_config.past_day_range);
  var formatted_startdate = Utilities.formatDate(start_date, Session.getScriptTimeZone(), "yyyy/MM/dd");
  var searchQuery = 'from:' + global_config.senderEmail + ' after:' + formatted_startdate + ' -label:' + global_config.processed_label;

  var threads = GmailApp.search(searchQuery);

  var author2parsed_papers = {}
  var total_citing_papers = 0
  var new_article_papers = {} // Dictionary keyed by URL
  var total_new_articles = 0

  for (var i = 0; i < threads.length; i++) {
    var messages = threads[i].getMessages();
    for (var j = 0; j < messages.length; j++) {
      var message = messages[j];
      var subject = message.getSubject()

      if (global_config.mark_as_unread){
        message.markRead()
      }

      if (subject.includes('citations to articles') || subject.includes('citation to articles') || subject.includes('your articles')){
        message_body = message.getPlainBody();
        titles2parsed_paper_dict = parse_citations_email(message_body)
        if (subject.includes('citations to articles') || subject.includes('citation to articles')){
          const index = subject.indexOf("by ");
          author_name = subject.slice(index+3).trim()
        } else {
          author_name = 'You'
        }

        if (author_name in author2parsed_papers){
          author2parsed_papers[author_name] = Object.assign(author2parsed_papers[author_name], titles2parsed_paper_dict)
        } else {
          author2parsed_papers[author_name] = titles2parsed_paper_dict
        }
        total_citing_papers += Object.keys(titles2parsed_paper_dict).length
      }
      else{
        // Parse new article emails
        message_body = message.getBody();
        parsed_article = parse_new_article_email(message_body, subject);
        // Merge parsed articles (keyed by URL)
        new_article_papers = Object.assign(new_article_papers, parsed_article);
        total_new_articles += Object.keys(parsed_article).length;
      }

      // Mark this message as processed
      threads[i].addLabel(label);
    }
  }

  // Use unified collation function
  var sorted_paper_dicts = collate_all_papers(author2parsed_papers, new_article_papers)
  var total_authors = Object.keys(author2parsed_papers).length
  var total_unique_papers = sorted_paper_dicts.length

  // Send unified digest
  if (total_unique_papers <= global_config.papers_per_merged_email){
    send_unified_digest(sorted_paper_dicts, total_citing_papers, total_authors, total_new_articles, total_unique_papers, 0)
  } else {
    batch_send_unified_digest(sorted_paper_dicts, total_citing_papers, total_authors, total_new_articles, total_unique_papers, global_config.papers_per_merged_email)
  }
}

// New function to handle batched new articles
function send_new_articles_batched(new_articles) {
  var now = new Date();
  var pretty_now = Utilities.formatDate(now, Session.getScriptTimeZone(), "EEE MMM dd yyyy");
  var articles_per_email = Math.floor(global_config.papers_per_merged_email / 2); // Use smaller batches for articles

  for (var batch_start = 0; batch_start < new_articles.length; batch_start += articles_per_email) {
    var batch_end = Math.min(batch_start + articles_per_email, new_articles.length);
    var batch_articles = new_articles.slice(batch_start, batch_end);
    var batch_num = Math.floor(batch_start / articles_per_email) + 1;

    var merged_body = '<html><body>';
    if (new_articles.length <= articles_per_email) {
      merged_body += `<h2>Collated new articles from ${new_articles.length} notifications</h2>`;
    } else {
      merged_body += `<h2>New articles - Part ${batch_num} (${batch_articles.length}/${new_articles.length})</h2>`;
    }

    for (var i = 0; i < batch_articles.length; i++) {
      merged_body += '<p>' + batch_articles[i].subject + '</p>';
      merged_body += '<div>' + batch_articles[i].body + '</div>';
      merged_body += '<hr>';
    }
    merged_body += '</body></html>';

    var subject = new_articles.length <= articles_per_email
      ? `Google Scholar New Articles Digest for ${pretty_now}`
      : `Google Scholar New Articles Digest for ${pretty_now} - Part ${batch_num}`;

    GmailApp.sendEmail(Session.getActiveUser().getEmail(), subject, '', {
      htmlBody: merged_body
    });
  }

  Logger.log('New articles emails sent successfully.');
}
