// @flow
type Socket = Object;
type Target = {
  tabId: number,
};
type NodeId = number;
type NodeMap = { [NodeId]: Node };
type CSSPropertyPath = {
  nodeId: NodeId,
  ruleIndex: number,
  propIndex: number,
};
type DebugStatus = 'ACTIVE' | 'INACTIVE';

declare var PDiffer;
declare var io: (string, ?Object) => Socket;
declare var ChromePromise;
declare var cssbeautify: string => string;
declare var chrome: Object;

const cp = new ChromePromise();
const PROTOCOL = '1.2';
const SOCKET_PORT = 1111;

const queue = [];

// Highlighting for DOM overlays.
const NODE_HIGHLIGHT: HighlightConfig = {
  contentColor: {
    r: 255,
    g: 0,
    b: 0,
    a: 0.3,
  },
  paddingColor: {
    r: 0,
    g: 255,
    b: 0,
    a: 0.3,
  },
  marginColor: {
    r: 0,
    g: 0,
    b: 255,
    a: 0.3,
  },
};

class BrowserEndpoint {
  socket: ?Socket;
  target: ?Target;
  document: ?Node;
  nodes: NodeMap;
  styles: { [NodeId]: MatchedStyles };
  inspectedNode: ?Node;
  differ: PDiffer;

  _debugEventDispatch: (Target, string, Object) => Promise<*>;
  _initializeDiffer: (Object, string, Object) => Promise<*>;

  constructor(port) {
    this.socket = io(`http://localhost:${port}/browsers`, {
      autoConnect: false,
      reconnectionAttempts: 5,
    });
    this.target = null;
    this.document = null;
    this.inspectedNode = null;
    this.styles = {};
    this.nodes = {};
    this.differ = new PDiffer();

    // Bind `this` in the constructor, so we can
    // detach event handler by reference during cleanup.
    this._debugEventDispatch = this._debugEventDispatch.bind(this);
    this._initializeDiffer = this._initializeDiffer.bind(this);
  }

  /**
   * Get the currently active tab in the focused Chrome
   * instance.
   */
  static async getActiveTab() {
    const tabs = await cp.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (tabs.length === 0) {
      throw new Error('getActiveTab: no active tab found');
    } else {
      return tabs[0];
    }
  }

  /**
   * Prepare to receive requests for debugger data.
   */
  async initConnections(tabId) {
    // Mount debugger.
    await cp.debugger.attach({ tabId }, PROTOCOL);

    this.target = { tabId };
    chrome.debugger.onDetach.addListener(this._onDebuggerDetach.bind(this));
    chrome.debugger.onEvent.addListener(this._debugEventDispatch);
    await Promise.all([
      this._sendDebugCommand({
        method: 'Page.enable',
      }),
      this._sendDebugCommand({
        method: 'DOM.enable',
      }),
    ]);
    // CSS requires DOM to be enabled first.
    await this._sendDebugCommand({
      method: 'CSS.enable',
    });
    console.log('Attached debugger to target', this.target);

    // Once we have the DOM and are ready to handle
    // incoming requests, open the socket.
    if (this.socket) {
      // Need to store the value of this.socket to
      // prevent Flow from invalidating the refinement.
      const { socket } = this;
      await new Promise(resolve => {
        socket.open();
        socket.on('data.req', this.onRequest.bind(this));
        socket.on('disconnect', this._onSocketDisconnect.bind(this));
        socket.on('connect', resolve);
      });
      console.log('Opened socket', this.socket);
    } else {
      console.error('No socket found, could not setup connections');
    }

    this.updateIcon('ACTIVE');

    // Once debugger is mounted and sockets are open,
    // get the DOM and push it to the server.
    await this.getDocumentRoot();
    console.log('Retrieved document root', this.document);
  }

  /**
   * Updates the browser icon badge to indicate the status
   * of the debugging process.
   */
  updateIcon(status: DebugStatus) {
    const path = {
      ACTIVE: 'icons/icon-active-16.png',
      INACTIVE: 'icons/icon-inactive-16.png',
    }[status];

    // When status is active, this.target will be
    // an object containing the tabId of the debugging
    // target.
    // We only want to change the icon for the active tab.
    const options = Object.assign(
      {},
      { path },
      this.target && { tabId: this.target.tabId }
    );

    chrome.browserAction.setIcon(options);
  }

  /**
   * Set the root of the document.
   */
  async getDocumentRoot() {
    // Calling DOM.getDocument will invalidate all nodes.
    this.inspectedNode = null;
    this.styles = {};
    this.nodes = {};

    const { root } = await this._sendDebugCommand({
      method: 'DOM.getDocument',
      params: { depth: -1 },
    });

    // Set parentId value on every node.
    const withParents = this._addParentIds(-1)(root);
    this.document = withParents;

    this._socketEmit('data.update', {
      type: 'UPDATE_DOCUMENT',
      nodes: this.nodes,
    });

    return withParents;
  }

  /**
   * Allow the user to select a node for focus.
   */
  async selectNode() {
    // Launch inspect mode.
    this._sendDebugCommand({
      method: 'DOM.setInspectMode',
      params: {
        mode: 'searchForNode',
        highlightConfig: NODE_HIGHLIGHT,
      },
    });
  }

  /**
   * Highlight a node on the inspected page.
   * If argument is null, disable highlight.
   */
  async highlightNode(nodeId: ?NodeId): Promise<*> {
    if (nodeId) {
      this._sendDebugCommand({
        method: 'DOM.highlightNode',
        params: {
          highlightConfig: NODE_HIGHLIGHT,
          nodeId,
        },
      });
    } else {
      this._sendDebugCommand({
        method: 'DOM.hideHighlight',
      });
    }
  }

  /**
   * Set parentId on every node in a given tree.
   */
  _addParentIds(parentId) {
    return node => {
      const { children, nodeId } = node;
      let edit = { parentId };

      if (children && children.length) {
        edit = {
          parentId,
          children: children.map(this._addParentIds(nodeId)),
        };
      }

      // Cache the node in an object for faster indexing later.
      const nodeWithParent = Object.assign({}, node, edit);
      this.nodes[nodeId] = nodeWithParent;
      return nodeWithParent;
    };
  }

  /**
   * Get the nodeId of the first match for the specified selector.
   */
  async getNodeId(selector: string): Promise<NodeId> {
    if (!this.document) {
      this.document = await this.getDocumentRoot();
    }

    let nodeId: NodeId;
    try {
      const response = await this._sendDebugCommand({
        method: 'DOM.querySelector',
        params: {
          selector,
          nodeId: this.document.nodeId,
        },
      });
      nodeId = response.nodeId;
    } catch (err) {
      throw err;
    }

    // Chrome Debugging Protocol returns nodeId of 0
    // if the node was not found.
    if (!nodeId) {
      throw new Error(`Couldn't retrieve nodeId for ${selector}`);
    }

    return nodeId;
  }

  /**
   * Get the DOM subtree for the node corresponding
   * to the given selector.
   * Takes a selector string or a nodeId number.
   */
  async getNode(what: NodeId | string, offsetParent = false): Promise<Node> {
    let id: NodeId;
    if (typeof what === 'number') {
      id = what;
    } else {
      try {
        id = await this.getNodeId(what);
      } catch (nodeIdError) {
        throw new Error(`getNode: could not get NodeId for selector ${what}`);
      }
    }

    let result: Node;

    if (this.nodes[id]) {
      result = this.nodes[id];
    } else {
      try {
        const searchResult = await this.searchDocument([id]);
        result = searchResult[id];
      } catch (err) {
        throw err;
      }
    }

    // Optionally also search for the node's offsetParent.
    if (offsetParent) {
      try {
        let offsetParentId: NodeId = await this.getOffsetParentId(id);
        let offsetParent: Node = await this.getNode(offsetParentId);
        result.offsetParent = offsetParent;
      } catch (err) {
        console.error('Error retrieving offsetParent for node', what);
      }
    }

    return result;
  }

  /**
   * Search breadth-first for a given set of nodes.
   */
  async searchDocument(wanted: NodeId[]): Promise<NodeMap> {
    if (!this.document) {
      this.document = await this.getDocumentRoot();
    }

    const queue: Node[] = [this.document];
    // NodeIds we are looking for, but haven't found.
    const missing: Set<NodeId> = new Set(wanted);
    // Nodes we've found, associated with their nodeId.
    const found: NodeMap = {};

    while (queue.length > 0) {
      const node: Node = queue.shift();
      const { nodeId } = node;

      if (missing.has(nodeId)) {
        found[nodeId] = node;
        missing.delete(nodeId);
      }

      // If `missing` is empty, we've found everything.
      if (missing.size === 0) {
        return found;
      }

      if (node.children) {
        queue.push(...node.children);
      }
    }

    /**
     * If search fails, return an Error object, which will be
     * checked by the caller and emitted back to the server.
     */
    const missingFormat: string = JSON.stringify(missing);
    throw new Error(`couldn't find nodes for ${missingFormat}`);
  }

  /**
   * Get computed and matched styles for the given node.
   */
  async getStyles(nodeId: NodeId): Promise<MatchedStyles> {
    let node: Node;
    try {
      node = await this.getNode(nodeId);
    } catch (err) {
      throw err;
    }

    const { parentId } = node;

    const commands = [
      {
        method: 'CSS.getMatchedStylesForNode',
        params: { nodeId },
      },
      {
        method: 'CSS.getComputedStyleForNode',
        params: { nodeId },
      },
      {
        method: 'CSS.getComputedStyleForNode',
        params: { nodeId: parentId },
      },
    ];

    const commandPromises = commands.map(this._sendDebugCommand.bind(this));
    const [matchedStyles, ...computedStyles] = await Promise.all(
      commandPromises
    );

    // Turn computed style arrays into ComputedStyleObjects.
    const [computedStyle, parentComputedStyle] = computedStyles
      // Extract the computed styles array from the response object.
      .map(({ computedStyle: cs }) =>
        cs.reduce(
          (memo, current) =>
            Object.assign(memo, { [current.name]: current.value }),
          {}
        )
      );

    // Reverse the order of the matched styles, so that the
    // highest-specificity styles come first.
    matchedStyles.matchedCSSRules.reverse();

    const styles = Object.assign(
      {},
      matchedStyles,
      { computedStyle },
      { parentComputedStyle }
    );

    this.styles[nodeId] = styles;
    return styles;
  }

  /**
   * Refresh stored styles, e.g. after a style edit has been made.
   */
  async refreshStyles(): Promise<*> {
    const storedNodeIds: NodeId[] = Object.keys(this.styles).map(nodeId =>
      parseInt(nodeId)
    );

    if (storedNodeIds.length) {
      const updatedStyles = await Promise.all(
        storedNodeIds.map(this.getStyles.bind(this))
      );

      // Reduce the pair of arrays back into an object.
      this.styles = updatedStyles.reduce(
        (acc, currentStyle, i) =>
          Object.assign(acc, {
            [storedNodeIds[i]]: currentStyle,
          }),
        {}
      );
    } else {
      console.log('No styles currently stored');
    }

    return this.styles;
  }

  /**
   * Get the nodeId of the given node's offsetParent.
   */
  async getOffsetParentId(nodeId: NodeId): Promise<NodeId> {
    // Set the node in question to the "currently"
    // "inspected" node, so we can use $0 in our
    // evaluation.
    await this._sendDebugCommand({
      method: 'DOM.setInspectedNode',
      params: { nodeId },
    });

    const { result } = await this._sendDebugCommand({
      method: 'Runtime.evaluate',
      params: {
        expression: '$0.parentNode',
        includeCommandLineAPI: true,
      },
    });

    const { objectId } = result;
    const offsetParentNode = await this._sendDebugCommand({
      method: 'DOM.requestNode',
      params: { objectId },
    });
    const offsetParentNodeId = offsetParentNode.nodeId;
    return offsetParentNodeId;
  }

  /**
   * Exposed handler, which toggles the style, updates the styles cache,
   * and responds with the updated styles.
   */
  async toggleStyleAndRefresh({
    nodeId,
    ruleIndex,
    propIndex,
  }: CSSPropertyPath): Promise<{
    [NodeId]: MatchedStyles,
  }> {
    await this._toggleStyle(nodeId, ruleIndex, propIndex);
    return await this.refreshStyles();
  }

  async _toggleStyle(
    nodeId: NodeId,
    ruleIndex: number,
    propIndex: number
  ): Promise<> {
    const style: CSSStyle = this.styles[nodeId].matchedCSSRules[ruleIndex].rule
      .style;
    const { range, styleSheetId, cssText: styleText } = style;
    const errorMsgRange = `node ${nodeId}, rule ${ruleIndex}, property ${propIndex}`;
    const property: CSSProperty = style.cssProperties[propIndex];
    if (!property) {
      throw new Error(`Couldn't get property for ${errorMsgRange}`);
    }
    const currentPropertyText = property.text;
    if (!currentPropertyText) {
      throw new Error(`Couldn't get text for property ${errorMsgRange}`);
    }
    let nextPropertyText;
    const hasDisabledProperty = Object.prototype.hasOwnProperty.call(
      property,
      'disabled'
    );
    if (!hasDisabledProperty) {
      throw new Error(
        `Property ${errorMsgRange} appears to not be a source-based property`
      );
    }
    const isDisabled = property.disabled;
    if (isDisabled) {
      // Need to re-enable it.
      // /* foo: bar; */ => foo: bar;
      const disabledRegex = /\/\*\s+(.+)\s+\*\//;
      const matches = currentPropertyText.match(disabledRegex);

      if (!matches || !matches[1]) {
        throw new Error(
          `Property ${errorMsgRange} is marked as disabled, but disabled pattern was not found`
        );
      }
      nextPropertyText = matches[1];
      if (!nextPropertyText) {
        throw new Error(
          `Couldn\'t find the original text in property ${currentPropertyText}`
        );
      }
    } else {
      // Property is enabled, need to disable it.
      if (currentPropertyText.lastIndexOf('\n') === -1) {
        nextPropertyText = `/* ${currentPropertyText} */`;
      } else {
        // If a property is last in its rule, it may have a newline
        // at the end. Appending */ to the end would invalidate the
        // SourceRange for the rule.
        const noNewLineRegex = /.+(?=\n)/m;
        // $` gives the part before the matched substring
        // $& gives the match
        // $' gives the suffix
        const replacementString = "$`/* $& */$'";
        nextPropertyText = currentPropertyText.replace(
          noNewLineRegex,
          replacementString
        );
      }
    }

    // Need to replace the current *style text* by searching for
    // the current *property text* within it, and replacing with
    // the updated *property text*.
    const currentStyleText = styleText;
    if (!currentStyleText) {
      throw new Error(
        `Couldn't get style text for node ${nodeId}, rule ${ruleIndex}`
      );
    }
    const nextStyleText = currentStyleText.replace(
      currentPropertyText,
      nextPropertyText
    );
    const edit = {
      styleSheetId,
      range,
      text: nextStyleText,
    };
    await this._sendDebugCommand({
      method: 'CSS.setStyleTexts',
      params: {
        edits: [edit],
      },
    });

    /**
     * Patch the locally-stored style.
     * Note that MULTIPLE style objects could be potentially stale,
     * and the caller needs to take care of refreshing the stored
     * styles and pushing an update to the server.
     * However, this monkeypatch will allow us to test an individual
     * toggling change more easily.
     */
    style.cssText = nextStyleText;
    property.text = nextPropertyText;
    property.disabled = !isDisabled;
  }

  isDisabled(path: CSSPropertyPath): boolean {
    let prop: ?CSSProperty;
    try {
      prop = this.resolveProp(path);
    } catch (propNotFoundErr) {
      return false;
    }
    return !!prop.disabled;
  }

  /**
   * Longhand properties that are expansions of shorthand properties
   * will not have their own SourceRanges or property text.
   */
  isDeclaredProperty(path: CSSPropertyPath): boolean {
    let prop: ?CSSProperty;
    try {
      prop = this.resolveProp(path);
    } catch (propNotFoundErr) {
      return false;
    }
    const hasText = !!prop.text;
    const hasRange = !!prop.range;
    return hasText && hasRange;
  }

  resolveProp(path: CSSPropertyPath): CSSProperty {
    if (!this.propExists(path)) {
      console.log(path);
      throw new Error(`resolveProp: property does not exist`);
    }
    const { nodeId, ruleIndex, propIndex } = path;
    return this.styles[nodeId].matchedCSSRules[ruleIndex].rule.style
      .cssProperties[propIndex];
  }

  propExists({ nodeId, ruleIndex, propIndex }: CSSPropertyPath): boolean {
    const nodeStyles: MatchedStyles = this.styles[nodeId];
    if (!nodeStyles) {
      return false;
    }
    const ruleMatch: RuleMatch = nodeStyles.matchedCSSRules[ruleIndex];
    if (!ruleMatch) {
      return false;
    }
    const prop: CSSProperty = ruleMatch.rule.style.cssProperties[propIndex];
    if (!prop) {
      return false;
    }
    return true;
  }

  /**
   * Dispatch an incoming request from the socket
   * server.
   */
  async onRequest(req) {
    const responseTypes = {
      REQUEST_NODE: 'RECEIVE_NODE',
      REQUEST_STYLES: 'RECEIVE_STYLES',
      TOGGLE_PROPERTY: 'RECEIVE_STYLES',
      PRUNE_STYLES: 'RECEIVE_STYLES',
    };

    const dispatch = {
      REQUEST_NODE: async (
        { selector } // Get offset parent
      ) => ({ node: await this.getNode(selector, true) }),
      HIGHLIGHT_NODE: async ({ nodeId }) => this.highlightNode(nodeId),
      HIGHLIGHT_NONE: () => this.highlightNode(null),
      REQUEST_STYLES: async ({ nodeId }) => ({
        updated: {
          [nodeId]: await this.getStyles(nodeId),
        },
      }),
      TOGGLE_PROPERTY: async ({ nodeId, ruleIndex, propIndex }) => ({
        updated: await this.toggleStyleAndRefresh({
          nodeId,
          ruleIndex,
          propIndex,
        }),
      }),
      PRUNE_STYLES: async ({ nodeId }) => {
        await this.prune(nodeId);
        return {
          updated: await this.refreshStyles(),
        };
      },
      DEFAULT: ({ type }) => new Error(`unrecognized request type ${type}`),
    };
    const action = dispatch[req.type] || dispatch['DEFAULT'];
    const result = await action(req);
    const responseType: ?string = responseTypes[req.type] || null;

    if (result instanceof Error) {
      this._socketEmit('data.err', {
        id: req.id,
        type: responseType,
        message: result.message,
      });
    } else {
      // If the request has a result, return it.
      // Some requests (e.g. HIGHLIGHT_NODE) do not have a response.
      if (responseType) {
        const data = Object.assign({}, req, result, { type: responseType });
        this._socketEmit('data.res', data);
      }
    }
  }

  /**
   * Prune properties for some node.
   */
  async prune(nodeId: NodeId): Promise<> {
    // Get current styles for the node.
    const nodeStyles: MatchedStyles = await this.getStyles(nodeId);
    const { matchedCSSRules } = nodeStyles;
    const allPruned = [];

    // TODO: This is going to break whenever the first property
    // isn't a source property...
    const prop = {
      nodeId,
      ruleIndex: 0,
      propIndex: 0,
    };
    const { data: base } = await this._sendDebugCommand({
      method: 'Page.captureScreenshot',
    });
    await this.differ.setBaseImage(base);
    chrome.tabs.create({ url: this.differ._prefixURI(base) });

    for (const [ruleIndex, ruleMatch] of matchedCSSRules.entries()) {
      const { cssProperties } = ruleMatch.rule.style;
      let propsRemoved: CSSProperty[] = [];

      for (const [propIndex, prop] of cssProperties.entries()) {
        const propPath: CSSPropertyPath = {
          nodeId,
          ruleIndex,
          propIndex,
        };
        // Don't try to toggle if the property is a longhand expansion,
        // or if it's already disabled.
        const skip: boolean =
          !this.isDeclaredProperty(propPath) || this.isDisabled(propPath);
        if (skip) {
          continue;
        }

        console.log('Testing property', prop.name);
        const screenshot: string = await this.getScreenshotForProperty(
          propPath
        );
        const diffResult = await this.differ.computeDiff(screenshot, {
          maxDiff: 0,
        });
        const pdiff: number = diffResult.pdiff;
        // If there is a nonzero difference, the property is potentially
        // relevant, so we put it back.
        if (pdiff > 0) {
          try {
            await this.toggleStyleAndRefresh({ nodeId, ruleIndex, propIndex });
          } catch (toggleStyleError) {
            console.error(toggleStyleError);
          }
        } else {
          // pdiff of 0 indicates pruning.
          propsRemoved.push(prop);
        }
      }
      console.log('Pruned', propsRemoved.length, 'from rule', ruleIndex);
      allPruned.push([ruleMatch.rule.selectorList.text, propsRemoved]);
    }
    console.log(allPruned);
  }

  async getScreenshotForProperty({
    nodeId,
    ruleIndex,
    propIndex,
  }: CSSPropertyPath): Promise<string> {
    await this.toggleStyleAndRefresh({ nodeId, ruleIndex, propIndex });
    const { data } = await this._sendDebugCommand({
      method: 'Page.captureScreenshot',
    });
    return data;
  }

  /**
   * Handle certain events from the debugger.
   */
  _debugEventDispatch(target: Target, method: string, params: Object) {
    const dispatch = {
      /**
       * When new stylesheets are added, reformat the text so that
       * each property is on its own line.
       *
       * This will make it easier to disable/re-enable without
       * messing up the SourceRanges of all other properties.
       */
      'CSS.styleSheetAdded': async ({ header }) => {
        const { styleSheetId } = header;
        const { text } = await window.endpoint._sendDebugCommand({
          method: 'CSS.getStyleSheetText',
          params: {
            styleSheetId,
          },
        });
        const formattedText = cssbeautify(text);
        this._sendDebugCommand({
          method: 'CSS.setStyleSheetText',
          params: {
            styleSheetId,
            text: formattedText,
          },
        });
      },
      /**
       * Fired when the document is updated and NodeIds
       * are no longer valid.
       */
      'DOM.documentUpdated': async () => {
        this.getDocumentRoot();
      },
      /**
       * Fired when a node is inspected after calling DOM.setInspectMode.
       * Sets this.inspectedNode to the NodeId of the clicked element.
       */
      'DOM.inspectNodeRequested': async ({ backendNodeId }) => {
        // Disable inspection mode.
        window.endpoint._sendDebugCommand({
          method: 'DOM.setInspectMode',
          params: { mode: 'none' },
        });

        // Get the nodeId corresponding to the backendId.
        const { nodeIds } = await this._sendDebugCommand({
          method: 'DOM.pushNodesByBackendIdsToFrontend',
          params: {
            backendNodeIds: [backendNodeId],
          },
        });
        const [inspectedNodeId] = nodeIds;
        const [node, styles] = await Promise.all([
          this.getNode(inspectedNodeId),
          this.getStyles(inspectedNodeId),
        ]);
        const data = { node, styles };
        this.inspectedNode = node;

        // Send resulting node to server.
        this._socketEmit('data.update', {
          type: 'UPDATE_ROOT',
          node: this.inspectedNode,
          nodeId: inspectedNodeId,
          styles: this.styles[inspectedNodeId],
        });

        // Log to debug console.
        console.log(`Inspecting node ${inspectedNodeId}`, this.inspectedNode);
      },
      /**
       * Clean up when we refresh page.
       */
      'Page.loadEventFired': this.cleanup,
    };

    const action = dispatch[method];

    if (action) {
      action(params);
    }
  }

  /**
   * Emit data over the socket.
   */
  _socketEmit(evtName: string, data: Object) {
    if (this.socket && this.socket.connected) {
      this.socket.emit(evtName, data);
      console.log(`Emitting ${evtName} to server`, data);
    } else {
      console.error(`No socket connection, couldn't emit message`, data);
    }
  }

  /**
   * Dispatch a command to the chrome.debugger API.
   */
  async _sendDebugCommand({ method, params }) {
    // Highlighting will get called frequently and clog the console.
    if (method !== 'DOM.highlightNode' && method !== 'DOM.hideHighlight') {
      console.log(method, params, this.target);
    }
    return await cp.debugger.sendCommand(this.target, method, params);
  }

  /**
   * Clean up socket connection and properties.
   */
  async cleanup() {
    if (this.socket && this.socket.connected) {
      this.socket.close();
    }
    if (this.target) {
      chrome.debugger.onEvent.removeListener(this._debugEventDispatch);
      await cp.debugger.detach(this.target);
    }
    if (window.endpoint) {
      delete window.endpoint;
    }
  }

  _onSocketDisconnect() {
    if (this.socket) {
      this.socket.off();
      this.socket = null;
    }
    console.log('Disconnected from socket');
    // this.cleanup();
  }

  _onDebuggerDetach() {
    if (this.target) {
      this.updateIcon('INACTIVE');
      this.target = null;
      this.document = null;
      console.log('Detached from debugging target');
    }
    this.cleanup();
  }
}

async function main() {
  if (!window.endpoint) {
    const endpoint = new BrowserEndpoint(SOCKET_PORT);
    window.endpoint = endpoint;
  }

  const { id: tabId } = await BrowserEndpoint.getActiveTab();
  const hasConnection =
    window.endpoint.target && window.endpoint.target.tabId === tabId;

  if (!hasConnection) {
    // Need to init connections.
    await window.endpoint.initConnections(tabId);
  }

  /**
   * Invoke node selection, now that we are guaranteed
   * to have an active endpoint attached to current tab.
   */
  window.endpoint.selectNode();
}

chrome.browserAction.onClicked.addListener(main);
