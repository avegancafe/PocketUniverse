import logger from '../../lib/logger';
import { RequestManager, Response } from '../../lib/request';
import { settings, listenForSettingsUpdates } from '../../lib/settings';
import { ethErrors } from 'eth-rpc-errors';

declare global {
  interface Window {
    ethereum?: any;
  }
}

const log = logger.child({ component: 'Injected' });
log.debug({ msg: 'Injected script loaded.' });

/// Handling all the request communication.
const REQUEST_MANAGER = new RequestManager();
listenForSettingsUpdates();

let cachedProxy: any;

// The current provider, MM etc.
// Note, this could be undefined at this point.
let currentProvider = window.ethereum;
log.debug({ provider: currentProvider }, 'Detected Provider');
let providerChanged = true;

const pocketUniverseProxyHandler = {
  get(target: any, prop: any, receiver: any) {
    log.debug({ prop, msg: 'Props' });
    /*
     * User has disabled PU, just reflect.
     */
    if (settings.disable) {
      return Reflect.get(target, prop, receiver);
    }

    // sendAsync is a deprecated method. Support this in-case old mints use it.
    // For some reason... OpenSea uses this O_O
    if (prop !== 'request' && prop !== 'send' && prop !== 'sendAsync') {
      return Reflect.get(target, prop, receiver);
    }

    // We have to capture the original call or we run into circular references.
    // TODO(jqphu): not entirely sure why we have circular calls. Test on sappyseals.io/staking.
    const originalCall = Reflect.get(target, prop, receiver);

    return async (...args: any) => {
      // Request always has 1 arg.
      const requestArg = args[0];
      log.debug({ args, target, originalCall, msg: 'Args' });

      if (
        requestArg.method !== 'eth_signTypedData_v3' &&
        requestArg.method !== 'eth_signTypedData_v4' &&
        requestArg.method !== 'eth_sendTransaction'
      ) {
        return originalCall(...args);
      }

      log.info({ args }, 'Request type');
      let response;
      if (requestArg.method === 'eth_sendTransaction') {
        log.info('Transaction Request');
        if (requestArg.params.length !== 1) {
          // Forward the request anyway.
          log.warn('Unexpected argument length.');
          return originalCall(...args);
        }

        log.info(requestArg, 'Request being sent');

        // Sending response.
        response = await REQUEST_MANAGER.request({
          chainId: await target.request({ method: 'eth_chainId' }),
          transaction: requestArg.params[0],
        });

        if (response === Response.Reject) {
          log.info('Reject');
          // Based on EIP-1103
          // eslint-disable-next-line no-throw-literal
          throw ethErrors.provider.userRejectedRequest(
            'PocketUniverse Tx Signature: User denied transaction signature.'
          );
        }
      } else if (
        requestArg.method === 'eth_signTypedData_v3' ||
        requestArg.method === 'eth_signTypedData_v4'
      ) {
        log.info('Signature Request');
        if (requestArg.params.length !== 2) {
          // Forward the request anyway.
          log.warn('Unexpected argument length.');
          return originalCall(...args);
        }

        const params = JSON.parse(requestArg.params[1]);
        log.info({ params }, 'Request being sent');

        // Sending response.
        response = await REQUEST_MANAGER.request({
          chainId: await target.request({ method: 'eth_chainId' }),
          domain: params['domain'],
          message: params['message'],
          primaryType: params['primaryType'],
        });

        if (response === Response.Reject) {
          log.info('Reject');
          // NOTE: Be cautious when changing this name. 1inch behaves strangely when the error message diverges.
          throw ethErrors.provider.userRejectedRequest(
            'PocketUniverse Message Signature: User denied message signature.'
          );
        }
      } else {
        throw new Error('Show never reach here');
      }

      // For error, we just continue, to make sure we don't block the user!
      if (response === Response.Continue || response === Response.Error) {
        log.info(response, 'Continue | Error');
        return originalCall(...args);
      }
    };
  },
};

Object.defineProperty(window, 'ethereum', {
  get() {
    log.debug('Getting window.ethereum');

    if (providerChanged) {
      log.debug({ currentProvider }, 'New provider');
      cachedProxy = new Proxy(currentProvider, pocketUniverseProxyHandler);
      providerChanged = false;
    }

    log.debug({ proxy: cachedProxy }, 'Returning proxy');
    return cachedProxy;
  },
  set(newProvider) {
    log.debug({ newProvider }, 'Setting new provider');
    providerChanged = true;
    currentProvider = newProvider;
  },
  // This needs to be set to `true` as when it is `false` the variable `ethereum` is defined in the local scope. Thus, when doing something like `const ethereum = ...` results in `ethereum` has already been declared.
  // If we're flipping this, make sure it works on nftydash
  configurable: true,
});
