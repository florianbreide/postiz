import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { YsocialAutomationRepository } from '../database/ysocial.automation.repository';
import { hasInternalPlug } from './automation.rules';

/**
 * Counts at the start what was set in Postiz before the block (D15): posts
 * with a repeat, posts with an internal plug, active global plugs. Numbers
 * only in the log, the start goes on: the hub alarms the posts, and a person
 * switches them off in Postiz (Hub infra/README.md 24).
 */
@Injectable()
export class YsocialAutomationCheck implements OnApplicationBootstrap {
  private readonly _logger = new Logger('ysocial');

  constructor(private _automation: YsocialAutomationRepository) {}

  async onApplicationBootstrap() {
    try {
      const counts = await this.count();
      const found = counts.repeats + counts.plugs + counts.globalPlugs;
      const line = `automation check repeats=${counts.repeats} plugs=${counts.plugs} globalPlugs=${counts.globalPlugs}`;
      if (found) {
        this._logger.warn(`${line}: in Postiz abschalten (Regel 2)`);
      } else {
        this._logger.log(line);
      }
    } catch (err) {
      this._logger.warn(
        `automation check failed error=${
          err instanceof Error ? err.name : 'Error'
        }`
      );
    }
  }

  async count() {
    const [repeats, rows, globalPlugs] = await Promise.all([
      this._automation.countRepeatingPosts(),
      this._automation.getPlugSettings(),
      this._automation.countActiveGlobalPlugs(),
    ]);
    const plugs = rows.filter(({ settings }) => {
      try {
        return hasInternalPlug(JSON.parse(settings || '{}'));
      } catch {
        return false;
      }
    }).length;
    return { repeats, plugs, globalPlugs };
  }
}
