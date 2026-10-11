/**
 * The authored outfits (chunk 25): human-readable names and one-line flavour for the
 * system-owned cold-start parties. Pure data. Theming follows packages/content: Old West
 * settlers, outlaws, frontier industry and animals only — no Indigenous content.
 *
 * Grouped by the region whose roster the outfit rides with; `authoredPartySpecs()` assigns
 * them band-major (three per region per band). Adding a band (AUTHORED_REPUTATION_CEILING)
 * needs OUTFITS_PER_REGION_PER_BAND more names per region, and the specs refuse to build
 * without them, so a content drop cannot ship nameless outfits.
 */
import type { RegionId } from "@caravan/content";

export interface AuthoredOutfit {
  readonly name: string;
  readonly flavor: string;
}

const o = (name: string, flavor: string): AuthoredOutfit => ({ name, flavor });

export const AUTHORED_OUTFITS: Readonly<Record<RegionId, readonly AuthoredOutfit[]>> = {
  desert: [
    o("Dry Gulch Boys", "Three brothers and a mule, short on water and shorter on patience."),
    o("Salt Flat Drifters", "They walked out of the white nothing with sunburn and a grudge."),
    o("Alkali Freighters", "Teamsters who stopped hauling freight and started taking it."),
    o("The Cistern Gang", "They know where every well is. They'd rather you didn't."),
    o("Sidewinder Crew", "Never seen coming; always heard too late."),
    o("Mesa Line Riders", "Hired to watch a fence line. Found something better to do."),
    o("Coyote Flats Outfit", "Half the pack is dogs. The other half howls louder."),
    o("Tumbleweed Syndicate", "No fixed address, no fixed loyalties, excellent timing."),
    o("Saguaro Toll Company", "They run a road nobody built and charge for the privilege."),
    o("Dust Devil Posse", "The sheriff's badge was real once. The sheriff wasn't."),
    o("Sunstroke Brigade", "Marches at noon because nobody else will."),
    o("Bone Dry Partnership", "A dissolved mining venture with the dynamite still in hand."),
    o("Longhorn Drovers' Union", "Twelve hundred head of cattle and the men who follow them anywhere."),
    o("Vaquero Compact", "Ropes, spurs and a handshake that has never once been honoured."),
    o("Hardpan Reclaimers", "They say the land was theirs by claim. The claim was forged."),
    o("Gila Bend Marauders", "Fast riders out of a town that no longer appears on maps."),
    o("The Mirage Company", "You'll see them twice: once on the horizon, once at the wagons."),
    o("Scorpion Pass Toll", "Nobody crosses the pass without paying. Nobody has crossed twice."),
    o("Copper Canyon Cartel", "Mine bosses who learned a caravan is a mine that comes to you."),
    o("Sand Ridge Wranglers", "Horse thieves by trade, wagon thieves by opportunity."),
    o("The Ocotillo Ring", "A bandit ring with a bookkeeper. The bookkeeper is the dangerous one."),
    o("Powder Monkey Collective", "Former blasting hands. They kept the powder and lost the foreman."),
    o("Sun Dog Riders", "Ride at dusk, strike at the second sun."),
    o("Caliche Kings", "They crowned themselves. Nobody has argued yet."),
  ],
  high_plains: [
    o("Homestead Holdouts", "Lost their claim to the railroad and took to taking it back."),
    o("Prairie Wolf Pack", "Grey shapes at the edge of the firelight, patient as winter."),
    o("Windmill Gang", "They cut your water line and sell you the fix."),
    o("Sodbusters' Levy", "Farmers with a grievance and a planting season to fund."),
    o("Buffalo Wallow Crew", "Hunters who ran out of buffalo and found caravans slower."),
    o("The Grange Riders", "A farmers' association that voted to stop asking nicely."),
    o("Railhead Rowdies", "Track gangs between contracts, with company tools and no company."),
    o("Drover's Rest Outfit", "They run the only roadhouse for fifty miles. The rates are theirs."),
    o("Chinook Raiders", "A warm wind out of nowhere, gone before the snow remembers."),
    o("Section Line Syndicate", "Surveyors who learned where every wagon has to pass."),
    o("Bluestem Brigade", "Hide in grass tall enough to lose a horse. You won't lose them."),
    o("Thunderhead Company", "The storm you watched coming all afternoon."),
    o("Shotgun Messenger Guild", "Ex-express guards who know exactly where the strongbox rides."),
    o("Barbed Wire Barons", "Fenced the open range, then charged the fence."),
    o("The Iron Horse Gang", "Rob the train, rob the wagon, rob whatever rolls."),
    o("Prairie Doctor's Party", "He treats the wounded on both sides, then presents the bill."),
    o("Tallgrass Toll Riders", "Stake a claim across the trail and call it a crossing fee."),
    o("Buffalo Hunter Cooperative", "Sharpshooters with long rifles and longer memories."),
    o("Meadowlark Marauders", "Named for a songbird; nothing else about them sings."),
    o("Cyclone Cellar Boys", "Came up out of the ground after the storm, wanting more than supper."),
    o("Whistle Stop Wreckers", "Hit the wagons at the water tower; always the water tower."),
    o("Hailstone Hundred", "Not a hundred of them. Feels like it when they arrive."),
    o("The Grasshopper Plague", "Strip a caravan to the axles and move on to the next field."),
    o("High Lonesome Riders", "Nobody knows where they winter. Everybody knows where they summer."),
  ],
  mountain: [
    o("Grizzly Creek Trappers", "Fur traders who gave up on pelts and kept the bear."),
    o("Timberline Gang", "Above the trees, below the snow, between you and the pass."),
    o("Hardrock Hirelings", "Miners between claims, with picks they're happy to swing at anything."),
    o("Deadfall Crew", "Loggers who learned a falling tree stops any wagon."),
    o("The Avalanche Club", "Starts small. Doesn't stop."),
    o("Mule Skinner Mafia", "Packers who run the only trail over the divide, and charge accordingly."),
    o("Blasting Crew Local", "Powder men with a union card and a short fuse."),
    o("Cougar Ridge Outfit", "They watch from the rocks for an hour before they come down."),
    o("Apothecary's Guard", "Tonic sellers with an escort, selling the cure for what the escort did."),
    o("Switchback Bandits", "You'll meet them at every hairpin on the way up."),
    o("Tailings Pile Gang", "Picked over everything the mine threw away. Now picking over you."),
    o("Sawmill Syndicate", "They cut the planks for your wagon and know exactly where they're weak."),
    o("Snowline Raiders", "They come down with the first snow and go up with the thaw."),
    o("Ore Cart Collective", "Run the cart line and the toll on it."),
    o("The Cirque Company", "Camped in a glacier bowl nobody can reach but them."),
    o("Pine Marten Crew", "Small, quick, into everything, out before the dogs wake."),
    o("Smelter Gang", "Turn ore into bars and bars into trouble."),
    o("Lumberjack Levy", "Axes, saws and a grudge about pay."),
    o("Pack Mule Brigade", "A supply train with no customers and a lot of empty saddlebags."),
    o("Boulder Field Boys", "Roll a rock, block a road, collect."),
    o("Icefall Irregulars", "Fight in weather no sane caravan travels in."),
    o("The Lost Lode Company", "Still looking for the mine. Found everyone else's gold instead."),
    o("Bighorn Pass Guard", "Self-appointed keepers of a pass that belongs to nobody."),
    o("Granite Gap Marauders", "Nothing grows there. Nothing needs to."),
  ],
  badlands: [
    o("Gunslinger's Dozen", "Not twelve of them. The name was a joke before the counting stopped."),
    o("Bounty Board Riders", "Hunt wanted men for pay; hunt caravans for practice."),
    o("Claim Jumpers' League", "Jump a claim, jump a wagon, jump town."),
    o("Rattler Den Gang", "Camped in a snake pit because nobody checks there."),
    o("Vulture Roost Crew", "Wait for the first wagon to stumble. It always stumbles."),
    o("Snake Oil Caravan", "A medicine show with a second act nobody pays to see."),
    o("Powder Thief Outfit", "Steal the powder, sell it back, keep a little."),
    o("Rail Bull Gang", "Railroad enforcers who switched sides when the pay stopped."),
    o("The Hangman's Reprieve", "Every man here was cut down early. None of them learned."),
    o("Boot Hill Society", "They fill the cemetery and sell the plots."),
    o("Alkali Spring Posse", "Guard the one sweet spring for a hundred miles. Guard it hard."),
    o("Buzzard Creek Bunch", "Dry creek, dry men, dry humour."),
    o("Wanted Poster Collective", "Their likenesses hang in six territories. Flattering, most of them."),
    o("Scalding Flats Syndicate", "Hot ground, hot tempers, hot lead."),
    o("The Hangdog Gang", "Look beaten until the shooting starts."),
    o("Badwater Toll Company", "Charge for water nobody else would drink."),
    o("Red Rock Raiders", "The rocks are red for a reason."),
    o("Coffin Ridge Riders", "The undertaker rides with them and takes measurements early."),
    o("Gallows Gulch Gang", "Escaped the gulch's gallows; came back for the sheriff's wagon."),
    o("Copperhead Compact", "Bite first, bargain after."),
    o("Dead Man's Draw Outfit", "A card game that ended badly, and a partnership that didn't."),
    o("Scorched Earth Company", "Leave nothing behind, not even the ruts."),
    o("Cinder Creek Marauders", "Burned out of three towns. Looking for a fourth."),
    o("Stovepipe Hat Gang", "Dress for a funeral; usually somebody else's."),
  ],
};
