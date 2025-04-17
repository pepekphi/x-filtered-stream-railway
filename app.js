const { TwitterApi } = require('twitter-api-v2');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// Load environment variables
const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Create clients
const twitterClient = new TwitterApi(TWITTER_BEARER_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Global variables for stream management
let streamInstance;
let isShuttingDown = false;

// Nostaleur only mode flag: when true, only tweets from username "nostaleur" will be forwarded to the webhook.
// let nostaleurOnly = true;

// Define inactivity timeout (set to 60 minutes)
const INACTIVITY_TIMEOUT = 5400000; // 90 minutes in ms

// Track the last time a tweet was received
let lastTweetTime = Date.now();

// Function to force a full container restart by exiting the process.
function forceFullRestart() {
  console.log("Forcing full container restart...");
  process.exit(1);
}

// Function to build the full tweet text using note_tweet and referenced tweets
function getFullTweetText(tweet, includes) {
  let fullText = tweet.note_tweet && tweet.note_tweet.text ? tweet.note_tweet.text : tweet.text;

  // Replace t.co URLs in the main tweet text with display URLs if available
  // Only replace if the display_url does not contain an ellipsis ("…")
  if (tweet.entities && tweet.entities.urls) {
    tweet.entities.urls.forEach(urlEntity => {
      if (!urlEntity.display_url.includes("…")) {
        fullText = fullText.replace(urlEntity.url, urlEntity.display_url);
      }
    });
  }

  if (tweet.referenced_tweets && includes && includes.tweets) {
    tweet.referenced_tweets.forEach(refTweet => {
      let referencedTweet = includes.tweets.find(t => t.id === refTweet.id);
      if (referencedTweet) {
        let referencedFullText = referencedTweet.note_tweet && referencedTweet.note_tweet.text
          ? referencedTweet.note_tweet.text
          : referencedTweet.text;
        // Replace t.co URLs in referenced tweet text with display URLs if available
        if (referencedTweet.entities && referencedTweet.entities.urls) {
          referencedTweet.entities.urls.forEach(urlEntity => {
            if (!urlEntity.display_url.includes("…")) {
              referencedFullText = referencedFullText.replace(urlEntity.url, urlEntity.display_url);
            }
          });
        }
        if (refTweet.type === "quoted") {
          let quotedUser = includes.users.find(u => u.id === referencedTweet.author_id);
          let quotedUsername = quotedUser ? quotedUser.username : "unknown";
          fullText += ` [quoted tweet by @${quotedUsername}]${referencedFullText}[/quoted tweet]`;
        } else if (refTweet.type === "retweeted") {
          let retweetedUser = includes.users.find(u => u.id === referencedTweet.author_id);
          let retweetedUsername = retweetedUser ? retweetedUser.username : "unknown";
          fullText = `RT @${retweetedUsername} ${referencedFullText}`;
        }
      }
    });
  }
  return fullText;
}

// Function to send tweet data to the webhook and to Supabase
async function forwardTweet(tweet, includes) {
  const user = includes.users.find(user => user.id === tweet.author_id);
  const username = user ? user.username : "unknown";

  let fullTweetText = getFullTweetText(tweet, includes);
  // Ensure no line breaks
  fullTweetText = fullTweetText.replace(/\n/g, ' ');

  const tweetExpandedURL = tweet.entities && tweet.entities.urls && tweet.entities.urls.length > 0
    ? tweet.entities.urls.reduce((max, current) => {
        return current.expanded_url.length > max.expanded_url.length ? current : max;
      }, tweet.entities.urls[0]).expanded_url
    : "";

  const payload = {
    timestamp: tweet.created_at,
    username,
    tweetId: tweet.id,
    conversationId: tweet.conversation_id,
    tweetText: fullTweetText,
    tweetExpandedURL,
  };

  try {
    // 1) Send to Google Apps Script webhook
    await axios.post(WEBHOOK_URL, payload);
    console.log(`Tweet ${tweet.id} forwarded to webhook.`);

    // 2) Insert into Supabase
    const { error } = await supabase
      .from('Posts')
      .insert([{
        post_id:       tweet.id,
        timestamp:     tweet.created_at,
        x_id:          tweet.author_id,
        conversation_id: tweet.conversation_id,
        text:          fullTweetText,
        expanded_url:  tweetExpandedURL,
      }]);

    if (error) {
      console.error(`Supabase insert error for tweet ${tweet.id}:`, error.message);
    } else {
      console.log(`Tweet ${tweet.id} logged to Supabase.`);
    }

  } catch (err) {
    console.error(`Error handling tweet ${tweet.id}:`, err.response?.data || err.message);
  }
}

// Function to initiate the stream connection with a recurring inactivity check
async function startStream() {
  if (streamInstance) {
    console.log('Stream is already active.');
    return;
  }

  // Set up a recurring check for inactivity every minute
  const inactivityInterval = setInterval(() => {
    // If 60 minutes have passed without receiving any tweets, force a full restart.
    if (Date.now() - lastTweetTime >= INACTIVITY_TIMEOUT) {
      console.log(`No data received for ${INACTIVITY_TIMEOUT / 60000} minutes. Forcing full container restart...`);
      clearInterval(inactivityInterval);
      forceFullRestart();
    }
  }, 60000); // check every minute

  try {
    streamInstance = await twitterClient.v2.searchStream({
      'tweet.fields': 'created_at,conversation_id,note_tweet,referenced_tweets,entities',
      'user.fields': 'username',
      expansions: 'author_id,referenced_tweets.id'
    });

    console.log('Connected to Twitter stream.');
    // Update the last tweet time on connection
    lastTweetTime = Date.now();

    for await (const { data, includes } of streamInstance) {
      lastTweetTime = Date.now(); // update on each tweet
      const usernameForLog = (includes && includes.users && includes.users[0])
        ? includes.users[0].username
        : "unknown";
      console.log(`New tweet detected: ${data.id} from @${usernameForLog}`);
      await forwardTweet(data, includes);
    }
  } catch (error) {
    if (error && error.code === 429) {
      console.error("Received 429 error. Forcing full container restart now.");
      clearInterval(inactivityInterval);
      forceFullRestart();
    } else if (error && error.name === 'AbortError') {
      console.log('Stream aborted.');
    } else {
      console.error('Stream error:', error);
    }
  } finally {
    clearInterval(inactivityInterval);
    if (streamInstance && typeof streamInstance.destroy === 'function') {
      try {
        streamInstance.destroy();
      } catch (err) {
        console.error("Error destroying stream:", err);
      }
    }
    streamInstance = null;
  }
}

// Function to manage reconnections; runs until a shutdown is requested.
async function runStream() {
  let reconnectDelay = 30000; // initial delay 30 seconds for non-rate-limit errors
  while (!isShuttingDown) {
    try {
      await startStream();
      reconnectDelay = 30000;
    } catch (error) {
      if (error && error.code === 429) {
        console.error("Received 429 error in runStream. Forcing full container restart now.");
        forceFullRestart();
      }
      console.error(`Stream disconnected. Reconnecting in ${reconnectDelay / 1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, reconnectDelay));
    }
  }
}

// Graceful shutdown: close the stream and exit.
function shutdown() {
  isShuttingDown = true;
  console.log('Shutdown initiated. Closing Twitter stream...');
  if (streamInstance && typeof streamInstance.destroy === 'function') {
    streamInstance.destroy();
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

runStream();
