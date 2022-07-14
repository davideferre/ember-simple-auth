import Base from 'ember-simple-auth/authenticators/base';

import { getOwner } from '@ember/application';
import { bind, cancel, later, run } from '@ember/runloop';
import { inject as service} from '@ember/service';
import { isEmpty, isPresent } from '@ember/utils';

export default class OAuth2PopupAuthenticator extends Base {

  @service popup;
  @service session;
  @service storage;

  authenticatedPromise;
  authenticationSuccess;
  authenticationFailure;
  authUri;
  clientId;
  clientSecret;
  loginPopup;
  popup;
  refreshAccessTokens;
  redirectUri;
  responseType;
  scope;
  tokenExchangeUri;
  _refreshTokenTimeout;

  constructor() {
    super(...arguments);
    let _fPopUpClosed = bind(this, this._popupClosedHandler);
    this.popup.on('closed', _fPopUpClosed);
    let _fAuthCodeReceived = bind(this, this._authCodeReceived);
    this.storage.on('changed', _fAuthCodeReceived);
    let _oAuth2Config = getOwner(this).resolveRegistration('config:environment').oauth2;
    this.refreshAccessTokens = _oAuth2Config.refreshAccessTokens === 'true' ? true : false;
    this.clientId = _oAuth2Config.clientId;
    this.clientSecret = _oAuth2Config.clientSecret;
    this.authUri = _oAuth2Config.authUri;
    this.redirectUri = _oAuth2Config.redirectUri;
    this.responseType = 'code';
    this.scope = _oAuth2Config.scope;
    this.authorizationCode;
    this.tokenExchangeUri = _oAuth2Config.tokenExchangeUri;
  }

  get tokenRefreshOffset() {
    const min = 5;
    const max = 10;

    return (Math.floor(Math.random() * (max - min)) + min) * 1000;
  }

  async authenticate() {
    this.authenticatedPromise = new Promise((fResolve, fReject) => {
      this.authenticationSuccess = fResolve;
      this.authenticationFailure = fReject;
    });
    try {
      await this._displayPopup();
    } catch (e) {
      return this.authenticationFailure(e);
    }
    this._schedulePopupPolling();
    return this.authenticatedPromise;
  }

  async _displayPopup() {
    let _sState = (Math.random() + 1).toString(36).substring(2);
    let _sLoginUrl = `${this.authUri}?client_id=${this.clientId}&redirect_uri=${this.redirectUri}&response_type=${this.responseType}&scope=${this.scope}&state=${_sState}`;
    try {
      this.loginPopup = await this.popup.open(_sLoginUrl, 'width=500,height=500');
    } catch (e) {
      return Promise.reject(e);
    }
    return Promise.resolve();
  }

  _schedulePopupPolling() {
    later(this, function () {
      if (!this.loginPopup) {
        return;
      }
      this.popup.poll();
      this._schedulePopupPolling();
    }, 35);
  }

  _popupClosedHandler() {
    this.loginPopup = null;
  }

  async restore(data) {
    const now = (new Date()).getTime();
    if (!isEmpty(data['expires_at']) && data['expires_at'] < now) {
      if (this.refreshAccessTokens) {
        try {
          await this._refreshAccessToken(data['refresh_token']);
        } catch (e) {
          return Promise.reject(e);
        }
        return Promise.resolve(data);
      } else {
        return Promise.reject();
      }
    } else {
      if (isEmpty(data['access_token'])) {
        return Promise.reject();
      } else {
        this._scheduleAccessTokenRefresh(data['expires_in'], data['expires_at'], data['refresh_token']);
        return Promise.resolve(data);
      }
    }
  }

  async _authCodeReceived() {
    let _sCode = this.storage.getItem('authcode');
    let _oCode;
    try {
      _oCode = JSON.parse(_sCode);
    } catch (e) {
      return this.authenticationFailure(e);
    }
    if (isPresent(_oCode) && isPresent(_oCode.code) && !isPresent(this.authorizationCode)) {
      this._authorizeWithCode(_oCode.code);
    }
  }

  async _authorizeWithCode(sCode) {
    this.loginPopup.close();
    this.authorizationCode = sCode;
    let _oTokens;
    try {
      _oTokens = await this._getTokens(this.authorizationCode);
    } catch (e) {
      return this.authenticationFailure(e);
    }
    _oTokens.expires_at = this._absolutizeExpirationTime(_oTokens.expires_in);
    this._scheduleAccessTokenRefresh(
      _oTokens.expires_in,
      _oTokens.expires_at,
      _oTokens.refresh_token,
    );
    this.trigger('sessionDataUpdated', _oTokens);
    return this.authenticationSuccess(_oTokens);
  }

  async _getTokens(sAuthorizationCode) {
    let _oData = {
      code: sAuthorizationCode,
      grant_type: 'authorization_code',
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    };
    let _oResponse;
    try {
      _oResponse = await this._makeTokenRequest(_oData);
    } catch (e) {
      return Promise.reject(e);
    }
    this.storage.removeItem('authcode');
    this.authorizationCode = null;
    return Promise.resolve(_oResponse);
  }

  _scheduleAccessTokenRefresh(expiresIn, expiresAt, refreshToken) {
    if (!this.refreshAccessTokens) {
      return;
    }
    const now = new Date().getTime();
    if (isEmpty(expiresAt) && !isEmpty(expiresIn)) {
      expiresAt = this._absolutizeExpirationTime(expiresIn, now);
    }
    const offset = this.tokenRefreshOffset;
    if (!isEmpty(refreshToken) && !isEmpty(expiresAt) && expiresAt > now - offset) {
      cancel(this._refreshTokenTimeout);
      delete this._refreshTokenTimeout;
      this._refreshTokenTimeout = later(
        this,
        this._refreshAccessToken,
        refreshToken,
        expiresAt - now - offset
      );
    }
  }

  _refreshAccessToken(sRefreshToken) {
    return new Promise(async (fResolve, fReject) => {
      let _oRequestData = {
        grant_type: 'refresh_token',
        refresh_token: sRefreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      };
      let _oResponse;
      try {
        _oResponse = await this._makeTokenRequest(_oRequestData);
      } catch (e) {
        return fReject(e);
      }
      run(() => {
        _oResponse.expires_at = this._absolutizeExpirationTime(
          _oResponse.expires_in
        );
        this._scheduleAccessTokenRefresh(
          _oResponse.expires_in,
          _oResponse.expires_at,
          _oResponse.refresh_token
        );
        let _oResponseData = {
          access_token: _oResponse.access_token,
          refresh_token: _oResponse.refresh_token,
          expires_in: _oResponse.expires_in,
          expires_at: _oResponse.expires_at,
          scope: _oResponse.scope,
        };
        this.trigger('sessionDataUpdated', _oResponseData);
        return fResolve(_oResponseData);
      });
    });
  }

  _makeRequest(sUrl, oOptions) {
    return new Promise((fResolve, fReject) => {
      return fetch(sUrl, oOptions)
        .then((oResponse) => {
          oResponse.text().then((sResponseText) => {
            let _oJsonResponse;
            try {
              if (sResponseText.length > 0) {
                _oJsonResponse = JSON.parse(sResponseText);
              } else {
                _oJsonResponse = {};
              }
              if (!oResponse.ok) {
                oResponse.responseJSON = _oJsonResponse;
                return fReject(oResponse);
              }
            } catch (SyntaxError) {
              oResponse.responseText = sResponseText;
              return fReject(oResponse);
            }
            return fResolve(_oJsonResponse);
          });
        })
        .catch((oError) => {
          return fReject(oError);
        });
    });
  }

  _makeTokenRequest(oData) {
    let _oHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' };
    let _sBody = Object.keys(oData).map((sKey) => `${encodeURIComponent(sKey)}=${encodeURIComponent(oData[sKey])}`).join('&');
    let _oOptions = {
      body: _sBody,
      headers: _oHeaders,
      method: 'POST',
    };
    return this._makeRequest(this.tokenExchangeUri, _oOptions)
  }

  _absolutizeExpirationTime(expiresIn, now) {
    if (!isEmpty(expiresIn)) {
      if (isEmpty(now)) {
        now = new Date().getTime();
      }
      return new Date(now + expiresIn * 1000).getTime();
    }
  }

}