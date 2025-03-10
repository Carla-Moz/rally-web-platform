/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import fs from "fs";
import path from "path";

import { Builder, Locator, logging, WebDriver } from "selenium-webdriver";
import { until } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox";
import chrome from "selenium-webdriver/chrome";

// The number of milliseconds to wait for some
// property to change in tests. This should be
// a long time to account for slow CI.
export const WAIT_FOR_PROPERTY = 10000;

/**
* Find the element and perform an action on it.
*
* @param {WebDriver} driver
*        The Selenium driver to use.
* @param {Locator} locator
*        The locator for an element to look for and execute actions on.
* @param {Function} action
*        A function in the form `e => {}` that will be called
*        and receive the element once ready.
*/
export async function findAndAct(driver: WebDriver, locator: Locator, action: Function) {

  // FIXME slow animations can obscure elements that the user is trying to interact with, without
  // a signal to know that they are complete the best we can do is retry them. Let's log it though,
  // the fact that it's happening at all means it might be a bad experience for users with slow and/or busy hardware.
  await driver.wait(async () => {
    try {
      const element = await driver.findElement(locator);
      await driver.wait(until.elementIsEnabled(element), WAIT_FOR_PROPERTY);
      await driver.wait(until.elementIsVisible(element), WAIT_FOR_PROPERTY);

      await action(element);
      return true;
    } catch (ex) {
      console.debug(`Element at locator ${locator} not ready when expected, retrying: ${ex.name}, ${ex.message}`);
      return false;
    }
  }, WAIT_FOR_PROPERTY);
}

/**
 * Search the extension output logs for a particular message.
 *
 * @param {WebDriver} driver
 *        WebDriver in use.
 * @param {string} testBrowser
 *        Browser in use.
 * @param {string} message
 *        Message to search for.
 * @returns {Promise<boolean>}
 *        Whether or not the message was found.
 */
export async function extensionLogsPresent(driver: WebDriver, testBrowser: string, message: string): Promise<boolean> {
  switch (testBrowser) {
    case "chrome":
      const logEntries = await driver.manage().logs().get(logging.Type.BROWSER);
      let found = false;
      for (const logEntry of logEntries) {
        if (logEntry.message.includes(message)) {
          found = true;
        }
      }
      return found;
    case "firefox":
      const fileBuffer = await fs.promises.readFile("./integration.log");
      return fileBuffer.toString().includes(message);
    default:
      throw new Error(`Unsupported browser: ${testBrowser}`);
  }
}

/**
 * Get a Selenium driver for using the Firefox browser.
 *
 * @param {Boolean} loadExtension
 *        Whether or not to load a WebExtension on start.
 * @param {Boolean} headlessMode
 *        Whether or not to run Firefox in headless mode.
 * @returns {Promise<WebDriver>} a WebDriver instance to control Firefox.
 */
export async function getFirefoxDriver(loadExtension: boolean, headlessMode: boolean): Promise<WebDriver> {
  const firefoxOptions = new firefox.Options();
  firefoxOptions.setPreference("devtools.console.stdout.content", true);

  if (headlessMode) {
    firefoxOptions.headless();
    firefoxOptions.addArguments("-width=1920", "-height=1080");
  }

  const driver = await new Builder()
    .forBrowser("firefox")
    .setFirefoxOptions(firefoxOptions)
    .setFirefoxService(new firefox.ServiceBuilder().setStdio("inherit"))
    .build();

  if (loadExtension) {
    // Extensions can only be loaded temporarily at runtime for Firefox Release.
    const isTemporaryAddon = true;
    // @ts-ignore this appears to be missing from the type definition, but it exists!
    driver.installAddon(`${__dirname}/extension.xpi`, isTemporaryAddon);
  }

  return driver;
}

/**
 * Get a Selenium driver for using the Chrome browser.
 *
 * @param {boolean} loadExtension
 *        Whether or not to load a WebExtension on start.
 * @param {boolean} headlessMode
 *        Whether or not to run Firefox in headless mode.
 * @returns {Promise<WebDriver>} a WebDriver instance to control Chrome.
 */
export async function getChromeDriver(loadExtension: boolean, headlessMode: boolean) {
  const chromeOptions = new chrome.Options();

  if (headlessMode && loadExtension) {
    throw new Error("Chrome Headless does not support extensionss")
  }

  const loggingPrefs = new logging.Preferences();
  loggingPrefs.setLevel(logging.Type.BROWSER, logging.Level.ALL);

  if (headlessMode) {
    chromeOptions.headless();
    chromeOptions.addArguments("window-size=1920,1080");
  }

  if (loadExtension) {
    const encode = (file) => {
      var stream = fs.readFileSync(file);
      return Buffer.from(stream).toString("base64");
    }

    chromeOptions.addExtensions(encode(path.resolve(__dirname, "extension.crx")));
  }

  return await new Builder()
    .forBrowser("chrome")
    .setChromeOptions(chromeOptions)
    .setLoggingPrefs(loggingPrefs)
    .build();
}
