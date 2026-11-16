package com.petclinic.controller.admin;

import com.petclinic.common.PageResult;
import com.petclinic.common.Result;
import com.petclinic.dto.PetForm;
import com.petclinic.dto.PetQuery;
import com.petclinic.security.LoginUser;
import com.petclinic.security.RequireRole;
import com.petclinic.service.PetService;
import com.petclinic.vo.PetVo;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 宠物档案管理（后台视角）。
 *
 * 与用户端的区别：不校验归属，供管理员按宠物名或主人信息检索、
 * 纠正明显错误（改字段）与处理重复录入（逻辑删除）。
 */
@Tag(name = "管理后台-宠物档案")
@RestController
@RequestMapping("/admin/pet")
@RequiredArgsConstructor
@RequireRole(LoginUser.ROLE_ADMIN)
public class AdminPetController {

    private final PetService petService;

    @Operation(summary = "宠物分页（宠物名/主人昵称/手机号）")
    @GetMapping("/page")
    public Result<PageResult<PetVo>> page(PetQuery query) {
        return Result.ok(petService.pageForAdmin(query));
    }

    @Operation(summary = "修改宠物档案（纠正明显错误，归属不变）")
    @PutMapping("/{id}")
    public Result<Void> update(@PathVariable Long id, @RequestBody PetForm req) {
        petService.updateByAdmin(id, req);
        return Result.ok("已保存", null);
    }

    @Operation(summary = "删除宠物档案（处理重复录入；历史预约里冗余了宠物名，不受影响）")
    @DeleteMapping("/{id}")
    public Result<Void> remove(@PathVariable Long id) {
        petService.removeByAdmin(id);
        return Result.ok("已删除", null);
    }
}
