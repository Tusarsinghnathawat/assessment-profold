const { createHandler } = require('@app-core/server');
const HttpRequest = require('@app-core/http-request');

/**
 * Split the reqline by pipe delimiters while enforcing exact spacing around '|'
 * No regex used.
 */
function splitByPipes(statement) {
  if (typeof statement !== 'string') {
    throw new Error('Invalid reqline input');
  }

  if (statement.length === 0) {
    throw new Error('Missing required HTTP keyword');
  }

  if (statement[0] === ' ' || statement[statement.length - 1] === ' ') {
    throw new Error('Multiple spaces found where single space expected');
  }

  const segments = [];
  let tokenStartIndex = 0;
  for (let i = 0; i < statement.length; i += 1) {
    const char = statement[i];
    if (char === '|') {
      const beforeIndex = i - 1;
      const afterIndex = i + 1;
      const beforeBeforeIndex = i - 2;
      const afterAfterIndex = i + 2;

      if (
        beforeIndex < 0 ||
        afterIndex >= statement.length ||
        statement[beforeIndex] !== ' ' ||
        statement[afterIndex] !== ' ' ||
        (beforeBeforeIndex >= 0 && statement[beforeBeforeIndex] === ' ') ||
        (afterAfterIndex < statement.length && statement[afterAfterIndex] === ' ')
      ) {
        throw new Error('Invalid spacing around pipe delimiter');
      }

      const segment = statement.substring(tokenStartIndex, beforeIndex);
      if (segment.length === 0) {
        throw new Error('Invalid spacing around pipe delimiter');
      }
      segments.push(segment);
      tokenStartIndex = i + 2; // skip "| "
    }
  }

  const lastSegment = statement.substring(tokenStartIndex);
  if (lastSegment.length === 0) {
    throw new Error('Invalid spacing around pipe delimiter');
  }
  segments.push(lastSegment);

  return segments;
}

function ensureSingleSpaceAfterKeyword(segment, keyword) {
  if (segment.indexOf(keyword) !== 0) {
    return false;
  }
  // Ensure there is exactly one space after keyword and some value exists
  const expectedPrefix = `${keyword} `;
  if (segment.slice(0, expectedPrefix.length) !== expectedPrefix) {
    return false;
  }
  if (segment.length === expectedPrefix.length) {
    throw new Error('Missing space after keyword');
  }
  if (segment[expectedPrefix.length] === ' ') {
    throw new Error('Multiple spaces found where single space expected');
  }
  return true;
}

function parseJSONStrict(jsonString, sectionName) {
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    if (sectionName === 'HEADERS') throw new Error('Invalid JSON format in HEADERS section');
    if (sectionName === 'QUERY') throw new Error('Invalid JSON format in QUERY section');
    if (sectionName === 'BODY') throw new Error('Invalid JSON format in BODY section');
    throw e;
  }
}

function buildQueryString(queryObject) {
  const keys = Object.keys(queryObject || {});
  if (keys.length === 0) return '';
  const parts = [];
  for (let kIndex = 0; kIndex < keys.length; kIndex += 1) {
    const key = keys[kIndex];
    const value = queryObject[key];
    const encodedKey = encodeURIComponent(String(key));
    const encodedValue = encodeURIComponent(String(value));
    parts.push(`${encodedKey}=${encodedValue}`);
  }
  return parts.join('&');
}

function constructFullURL(baseURL, queryObject) {
  const queryString = buildQueryString(queryObject);
  if (!queryString) return baseURL;
  const hasQuery = baseURL.indexOf('?') !== -1;
  return `${baseURL}${hasQuery ? '&' : '?'}${queryString}`;
}

function parseReqline(statement) {
  const segments = splitByPipes(statement);

  // Validate required order: HTTP first, URL second
  if (!segments[0] || segments[0].slice(0, 4) !== 'HTTP') {
    throw new Error('Missing required HTTP keyword');
  }
  if (!segments[1] || segments[1].slice(0, 3) !== 'URL') {
    throw new Error('Missing required URL keyword');
  }

  const allowedKeywords = ['HTTP', 'URL', 'HEADERS', 'QUERY', 'BODY'];
  const seen = Object.create(null);

  let httpMethod = '';
  let baseURL = '';
  let headers = {};
  let query = {};
  let body = {};

  for (let sIndex = 0; sIndex < segments.length; sIndex += 1) {
    const segment = segments[sIndex];
    const firstSpaceIndex = segment.indexOf(' ');
    if (firstSpaceIndex === -1) {
      // No space after keyword
      throw new Error('Missing space after keyword');
    }
    const keyword = segment.slice(0, firstSpaceIndex);
    const value = segment.slice(firstSpaceIndex + 1);

    if (keyword !== keyword.toUpperCase()) {
      throw new Error('Keywords must be uppercase');
    }
    if (allowedKeywords.indexOf(keyword) === -1) {
      throw new Error('Keywords must be uppercase');
    }

    if (seen[keyword]) {
      throw new Error(`Duplicate section ${keyword}`);
    }
    seen[keyword] = true;

    ensureSingleSpaceAfterKeyword(segment, keyword);

    if (keyword === 'HTTP') {
      httpMethod = value;
      if (httpMethod !== httpMethod.toUpperCase()) {
        throw new Error('HTTP method must be uppercase');
      }
      if (httpMethod !== 'GET' && httpMethod !== 'POST') {
        throw new Error('Invalid HTTP method. Only GET and POST are supported');
      }
    } else if (keyword === 'URL') {
      baseURL = value;
    } else if (keyword === 'HEADERS') {
      headers = parseJSONStrict(value, 'HEADERS');
    } else if (keyword === 'QUERY') {
      query = parseJSONStrict(value, 'QUERY');
    } else if (keyword === 'BODY') {
      body = parseJSONStrict(value, 'BODY');
    }
  }

  const fullURL = constructFullURL(baseURL, query);

  return {
    method: httpMethod,
    url: baseURL,
    headers,
    query,
    body,
    full_url: fullURL,
  };
}

module.exports = createHandler({
  path: '/',
  method: 'post',
  async handler(rc) {
    try {
      const reqline = rc.body && rc.body.reqline;
      if (typeof reqline !== 'string') {
        return {
          status: 400,
          data: { error: true, message: 'Invalid reqline input' },
        };
      }

      const parsed = parseReqline(reqline);
      const requestStart = Date.now();

      let httpStatus = 0;
      let responseData = null;
      try {
        if (parsed.method === 'GET') {
          const res = await HttpRequest.get(parsed.full_url, { headers: parsed.headers });
          httpStatus = res.statusCode;
          responseData = res.data;
        } else if (parsed.method === 'POST') {
          const res = await HttpRequest.post(parsed.full_url, parsed.body, {
            headers: parsed.headers,
          });
          httpStatus = res.statusCode;
          responseData = res.data;
        }
      } catch (e) {
        // Handle network/HTTP errors and still return success shape
        const ctx = e && e.context && e.context.response ? e.context.response : {};
        httpStatus = ctx.statusCode || 0;
        responseData = ctx.data || { error: true, message: e.message };
      }

      const requestStop = Date.now();
      const duration = requestStop - requestStart;

      return {
        status: 200,
        data: {
          request: {
            query: parsed.query || {},
            body: parsed.body || {},
            headers: parsed.headers || {},
            full_url: parsed.full_url,
          },
          response: {
            http_status: httpStatus,
            duration,
            request_start_timestamp: requestStart,
            request_stop_timestamp: requestStop,
            response_data: responseData,
          },
        },
      };
    } catch (error) {
      return {
        status: 400,
        data: {
          error: true,
          message: error.message || 'Some error occured. Please check your reqline statement',
        },
      };
    }
  },
});
