import { net, session } from 'electron';

export class YouTubeExtractor {
  public static cipherCache = {
    playerUrl: '',
    decipherFn: null as Function | null
  };

  public static async getDecipherFunction(playerUrl: string): Promise<Function | null> {
    if (this.cipherCache.playerUrl === playerUrl && this.cipherCache.decipherFn) {
      return this.cipherCache.decipherFn;
    }

    try {
      const headers = { 'User-Agent': session.defaultSession.getUserAgent() };
      const res = await net.fetch(playerUrl, { headers });
      if (!res.ok) return null;
      const baseJs = await res.text();

      const fn = this.extractDecipher(baseJs);
      if (fn) {
        this.cipherCache = { playerUrl, decipherFn: fn };
      }
      return fn;
    } catch (e) {
      console.error('[YouTubeExtractor] Error fetching base.js:', e);
      return null;
    }
  }

  private static extractDecipher(baseJs: string): Function | null {
    try {
      const fnNameMatch = baseJs.match(/\b([a-zA-Z0-9$]{2,})\s*=\s*function\(\s*a\s*\)\s*\{\s*a\s*=\s*a\.split\(\s*""\s*\)/);
      if (!fnNameMatch) return null;
      const fnName = fnNameMatch[1];

      const escapedFnName = fnName.replace(/\$/g, '\\$');
      const fnBodyRegex = new RegExp(escapedFnName + '\\s*=\\s*function\\(\\s*([a-zA-Z0-9$]+)\\s*\\)\\s*\\{([^}]+)\\}');
      const fnBodyMatch = baseJs.match(fnBodyRegex);
      if (!fnBodyMatch) return null;
      const fnArg = fnBodyMatch[1];
      const fnBody = fnBodyMatch[2];

      const objNameMatch = fnBody.match(/([a-zA-Z0-9$]{2,})\.[a-zA-Z0-9$]{2,}\(/);
      if (!objNameMatch) return null;
      const objName = objNameMatch[1];

      const escapedObjName = objName.replace(/\$/g, '\\$');
      const objBodyRegex = new RegExp('var\\s+' + escapedObjName + '\\s*=\\s*\\{([\\s\\S]+?)\\};');
      const objBodyMatch = baseJs.match(objBodyRegex);
      if (!objBodyMatch) return null;
      const objBody = objBodyMatch[1];

      const evalCode = `
        var ${objName} = {${objBody}};
        return function(${fnArg}) {
          ${fnBody}
          return ${fnArg};
        };
      `;
      return new Function(evalCode)();
    } catch (e) {
      console.error('[YouTubeExtractor] Error extrayendo cipher:', e);
      return null;
    }
  }
}
